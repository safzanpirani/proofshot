import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runInNewContext } from 'node:vm';
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
    fs.rmSync(sessionDir, { recursive: true, force: true });
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

  it.each([
    ['visible', false, true],
    ['absent', false, false],
    ['visible', true, false],
    ['absent', true, true],
  ])('preserves %s assertions for nested matches (hidden=%s)', async (type, hidden, passed) => {
    const parent = { textContent: 'Needle', parentElement: null, checkVisibility: () => true };
    const child = { textContent: 'Needle', parentElement: parent, checkVisibility: () => !hidden };
    mocks.abArgs.mockImplementation((args: string[]) => args[1]?.includes('querySelectorAll')
      ? JSON.stringify(runInNewContext(args[1], { document: { querySelectorAll: () => [parent, child] } })) : '');
    await execCommand(['assert', String(type), 'Needle']);
    expect(readSessionLog(sessionDir).entries[0].assertion?.passed).toBe(passed);
  });

  it('matches text spanning siblings while rejecting an unrelated hidden leaf', async () => {
    const parent = { textContent: 'Hello world', parentElement: null, checkVisibility: () => true };
    const nodes = [parent,
      { textContent: 'Hello ', parentElement: parent, checkVisibility: () => true },
      { textContent: 'world', parentElement: parent, checkVisibility: () => true },
      { textContent: 'Hello world', parentElement: null, checkVisibility: () => false }];
    mocks.abArgs.mockImplementation((args: string[]) => args[1]?.includes('querySelectorAll')
      ? JSON.stringify(runInNewContext(args[1], { document: { querySelectorAll: () => nodes } })) : '');
    await execCommand(['assert', 'visible', 'Hello world']);
    expect(readSessionLog(sessionDir).entries[0].assertion?.passed).toBe(true);
  });

  it('reads each parent once on a large set of matches without containment scans', async () => {
    let parentReads = 0;
    const nodes = Array.from({ length: 10000 }, () => ({
      textContent: 'Needle',
      get parentElement() { parentReads++; return null; },
      contains: () => { throw new Error('Unexpected pairwise scan'); },
      checkVisibility: () => false,
    }));
    mocks.abArgs.mockImplementation((args: string[]) => args[1]?.includes('querySelectorAll')
      ? JSON.stringify(runInNewContext(args[1], { document: { querySelectorAll: () => nodes } })) : '');
    await execCommand(['assert', 'absent', 'Needle']);
    expect(readSessionLog(sessionDir).entries[0].assertion?.passed).toBe(true);
    expect(parentReads).toBe(nodes.length);
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

  it.each(['{}', 'null', '{"success":false,"data":{"messages":[]}}', '{"data":{"messages":[{}]}}'])
    ('does not pass console assertions for malformed data: %s', async (response) => {
      mocks.abArgs.mockImplementation((args: string[]) => args[0] === 'console' ? response : '');
      await execCommand(['assert', 'no-console-errors']);
      expect(process.exitCode).toBe(1);
      expect(readSessionLog(sessionDir).entries[0]).toMatchObject({ success: false, exitStatus: 1 });
    });

  it('recognizes console errors in the supported bare-array response', async () => {
    mocks.abArgs.mockImplementation((args: string[]) => args[0] === 'console'
      ? JSON.stringify([{ type: 'error', text: 'Application failed', timestamp: Date.now() }]) : '');
    await execCommand(['assert', 'no-console-errors']);
    expect(readSessionLog(sessionDir).entries[0].assertion?.passed).toBe(false);
  });

  it.each(['log', 'error'])('handles untimed %s messages from the native browser', async (type) => {
    mocks.abArgs.mockImplementation((args: string[]) => args[0] === 'console'
      ? JSON.stringify({ success: true, data: { messages: [{ type, text: 'Review console capture' }] } }) : '');
    await execCommand(['assert', 'no-console-errors']);
    expect(readSessionLog(sessionDir).entries[0].assertion?.passed).toBe(type !== 'error');
  });

  it('rejects a non-boolean visibility response', async () => {
    mocks.abArgs.mockReturnValue('{"error":"evaluation unavailable"}');
    await execCommand(['assert', 'visible', 'Saved']);
    expect(readSessionLog(sessionDir).entries[0]).toMatchObject({ success: false, exitStatus: 1 });
  });

  it('logs viewport verification failures and includes recovery in the outcome', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now += 500);
    vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    mocks.abArgs.mockImplementation((args: string[]) => args[0] === 'eval'
      ? JSON.stringify({ width: 1280, height: 720 }) : 'Done');
    await execCommand(['set', 'viewport', '390', '844']);
    expect(mocks.abArgs).toHaveBeenCalledWith(['set', 'viewport', '391', '845'], expect.anything());
    expect(readSessionLog(sessionDir).entries[0]).toMatchObject({ success: false, exitStatus: 1,
      stderr: expect.stringContaining('requested 390x844') });
    expect(process.stdout.write).not.toHaveBeenCalledWith('Done');
    expect(process.exitCode).toBe(1);
  });

  it('does not resize again after the original viewport command fails', async () => {
    mocks.abArgs.mockImplementation((args: string[]) => {
      if (args[0] === 'set') throw new Error('Browser unavailable');
      return '';
    });
    await execCommand(['set', 'viewport', '390', '844']);
    expect(mocks.abArgs.mock.calls.filter(([args]) => args[0] === 'set')).toHaveLength(1);
    expect(mocks.saveSession).not.toHaveBeenCalled();
  });

  it('records a recovered viewport as successful', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now += 500);
    vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    let resizes = 0;
    mocks.abArgs.mockImplementation((args: string[]) => {
      if (args[0] === 'set') { resizes++; return 'Done'; }
      return JSON.stringify(resizes >= 3 ? { width: 390, height: 844 } : { width: 1280, height: 720 });
    });
    await execCommand(['set', 'viewport', '390', '844']);
    expect(resizes).toBe(3);
    expect(readSessionLog(sessionDir).entries[0]).toMatchObject({ success: true, exitStatus: 0 });
    expect(mocks.saveSession).toHaveBeenCalledWith(expect.objectContaining({ viewport: { width: 390, height: 844 } }));
  });

  it('captures the exact ref with two bounded reads before clicking', async () => {
    mocks.abArgs.mockImplementation((args: string[]) => {
      if (args[1] === 'box') return JSON.stringify({ success: true, data: { x: 10, y: 20, width: 30, height: 40 } });
      if (args[1] === 'text') return JSON.stringify({ success: true, data: { text: 'Save' } });
      return '';
    });
    await execCommand(['click', '@e3']);
    expect(mocks.abArgs.mock.calls.slice(0, 3)).toEqual([
      [['get', 'box', '@e3', '--json'], { session: 'proofshot-test', timeoutMs: 1500 }],
      [['get', 'text', '@e3', '--json'], { session: 'proofshot-test', timeoutMs: 1500 }],
      [['click', '@e3'], { session: 'proofshot-test', timeoutMs: 60000 }],
    ]);
    expect(readSessionLog(sessionDir).entries[0].element).toMatchObject({ label: 'Save', bbox: { x: 10, y: 20, width: 30, height: 40 } });
  });

  it('still executes the action when optional overlay collection fails', async () => {
    mocks.abArgs.mockImplementation((args: string[]) => {
      if (args[0] === 'get') throw new Error('Unsupported ref');
      return '';
    });
    await execCommand(['click', '@e3']);
    expect(mocks.abArgs.mock.calls.filter(([args]) => args[0] === 'get')).toHaveLength(1);
    expect(readSessionLog(sessionDir).entries[0]).toMatchObject({ success: true });
  });

  it('does not look up refs found inside entered text', async () => {
    await execCommand(['fill', '#message', 'Ask @e3 for help']);
    expect(mocks.abArgs.mock.calls.some(([args]) => args[0] === 'get')).toBe(false);
  });
});
