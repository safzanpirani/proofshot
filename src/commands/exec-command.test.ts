import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../session/state.js';
import { execCommand, readSessionLog } from './exec.js';

const mocks = vi.hoisted(() => ({
  abArgs: vi.fn(),
  loadConfig: vi.fn(),
  loadSession: vi.fn(),
  saveSession: vi.fn(),
  setAgentBrowserDefaults: vi.fn(),
}));

vi.mock('../utils/config.js', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('../session/state.js', () => ({
  loadSession: mocks.loadSession,
  saveSession: mocks.saveSession,
}));
vi.mock('../utils/exec.js', () => ({
  abArgs: mocks.abArgs,
  buildAgentBrowserCommand: vi.fn((command: string) => `agent-browser ${command}`),
  setAgentBrowserDefaults: mocks.setAgentBrowserDefaults,
}));

let sessionDir: string;
let originalExitCode: number | string | null | undefined;

function sessionState(directory: string): SessionState {
  return {
    schemaVersion: 2,
    ownershipToken: 'test-owner',
    startedAt: new Date(Date.now() - 1000).toISOString(),
    description: null,
    outputDir: path.dirname(directory),
    sessionDir: directory,
    sessionName: 'proofshot-test',
    videoPath: path.join(directory, 'session.webm'),
    serverErrorLog: path.join(directory, 'server.log'),
    port: 3000,
    serverCommand: null,
    serverAlreadyRunning: true,
    recordingActive: true,
    initialViewport: { width: 1280, height: 720 },
    viewportChanges: [],
    headless: true,
    deviceScaleFactor: 1,
  };
}

describe('execCommand local assertions and logging', () => {
  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-exec-test-'));
    mocks.loadConfig.mockReturnValue({
      output: path.dirname(sessionDir),
      browser: {},
    });
    mocks.loadSession.mockReturnValue(sessionState(sessionDir));
    mocks.abArgs.mockImplementation((args: string[]) => {
      if (args[0] === 'eval' && args[1] === 'window.location.href') {
        return JSON.stringify('http://localhost:3000/page');
      }
      if (args[0] === 'eval' && args[1]?.includes('querySelectorAll')) return 'false';
      return '';
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it.each([
    [['assert', 'url', '   '], 'assert url requires a non-empty URL fragment'],
    [['assert', 'something-new'], 'Unknown assertion'],
  ] as const)('prints and persists a failed malformed assertion', async (args, message) => {
    await execCommand([...args]);

    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining(`Error: ${message}`));
    const entry = readSessionLog(sessionDir).entries[0];
    expect(entry.success).toBe(false);
    expect(entry.exitStatus).toBe(1);
    expect(entry.assertion).toMatchObject({ passed: false });
    expect(entry.assertion?.message).toContain(message);
    expect(JSON.parse(fs.readFileSync(path.join(sessionDir, 'result.json'), 'utf-8'))).toMatchObject({
      passed: false,
    });
  });

  it('evaluates leaf matches with computed visibility', async () => {
    await execCommand(['assert', 'visible', 'Hidden child']);

    const evalCall = mocks.abArgs.mock.calls.find(
      ([args]) => args[0] === 'eval' && args[1]?.includes('querySelectorAll'),
    );
    expect(evalCall?.[0][1]).toContain('const smallest =');
    expect(evalCall?.[0][1]).toContain('element.checkVisibility');
    expect(evalCall?.[0][1]).toContain('getComputedStyle(current)');
    expect(readSessionLog(sessionDir).entries[0].assertion).toMatchObject({ passed: false });
  });

  it('does not write entered values into viewer-bound session data', async () => {
    const enteredValue = 'private value with spaces & symbols';
    mocks.abArgs.mockImplementation((args: string[]) => {
      if (args[0] === 'eval' && args[1] === 'window.location.href') {
        return JSON.stringify(`http://localhost:3000/search?q=${encodeURIComponent(enteredValue)}`);
      }
      return '';
    });
    await execCommand(['fill', '@e1', enteredValue]);

    const logText = fs.readFileSync(path.join(sessionDir, 'session-log.jsonl'), 'utf-8');
    expect(logText).not.toContain(enteredValue);
    expect(logText).not.toContain(encodeURIComponent(enteredValue));
    expect(readSessionLog(sessionDir).entries[0]).toMatchObject({
      action: 'fill @e1 [REDACTED]',
      resultingUrl: 'http://localhost:3000/search?q=[REDACTED]',
    });
  });

  it('redacts entered values from failed command output', async () => {
    const enteredValue = 'never print this password';
    mocks.abArgs.mockImplementation((args: string[]) => {
      if (args[0] === 'fill') {
        const error = new Error('Browser command failed') as Error & {
          cause?: { status: number; stdout: Buffer; stderr: Buffer };
        };
        error.cause = {
          status: 1,
          stdout: Buffer.from(`attempted ${enteredValue}\n`),
          stderr: Buffer.from(`rejected ${enteredValue}\n`),
        };
        throw error;
      }
      if (args[0] === 'eval') return JSON.stringify('http://localhost:3000/');
      return '';
    });

    await execCommand(['fill', '@e1', enteredValue]);

    const terminalOutput = [
      ...vi.mocked(process.stdout.write).mock.calls,
      ...vi.mocked(process.stderr.write).mock.calls,
    ].flat().join('\n');
    expect(terminalOutput).not.toContain(enteredValue);
    expect(terminalOutput).toContain('[REDACTED]');
    expect(fs.readFileSync(path.join(sessionDir, 'session-log.jsonl'), 'utf-8')).not.toContain(enteredValue);
  });
});
