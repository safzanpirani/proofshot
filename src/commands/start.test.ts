import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashWorkingTreeDiff, parseChangedFiles, startCommand } from './start.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  ensureDevServer: vi.fn(),
  openBrowser: vi.fn(),
  closeBrowser: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  ensureOutputDir: vi.fn(),
  generateTimestamp: vi.fn(),
  generateSessionDirName: vi.fn(),
  saveSession: vi.fn(),
  hasActiveSession: vi.fn(),
  clearSession: vi.fn(),
  loadSession: vi.fn(),
  acquireSessionStartLock: vi.fn(),
  releaseSessionStartLock: vi.fn(),
  generateAgentBrowserSessionName: vi.fn(),
  writeSessionPointer: vi.fn(),
  writeMetadata: vi.fn(),
  ab: vi.fn(),
  abArgs: vi.fn(),
  setAgentBrowserDefaults: vi.fn(),
  getProcessIdentity: vi.fn(),
  processIdentityMatches: vi.fn(),
  terminateOwnedProcessTree: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('../utils/config.js', () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock('../server/start.js', () => ({
  ensureDevServer: mocks.ensureDevServer,
}));

vi.mock('../browser/session.js', () => ({
  openBrowser: mocks.openBrowser,
  closeBrowser: mocks.closeBrowser,
}));

vi.mock('../browser/capture.js', () => ({
  startRecording: mocks.startRecording,
  stopRecording: mocks.stopRecording,
}));

vi.mock('../utils/exec.js', () => ({
  ab: mocks.ab,
  abArgs: mocks.abArgs,
  setAgentBrowserDefaults: mocks.setAgentBrowserDefaults,
}));

vi.mock('../utils/process.js', () => ({
  getProcessIdentity: mocks.getProcessIdentity,
  processIdentityMatches: mocks.processIdentityMatches,
  terminateOwnedProcessTree: mocks.terminateOwnedProcessTree,
}));

vi.mock('../artifacts/bundle.js', () => ({
  ensureOutputDir: mocks.ensureOutputDir,
  generateTimestamp: mocks.generateTimestamp,
  generateSessionDirName: mocks.generateSessionDirName,
}));

vi.mock('../session/state.js', () => ({
  saveSession: mocks.saveSession,
  hasActiveSession: mocks.hasActiveSession,
  clearSession: mocks.clearSession,
  acquireSessionStartLock: mocks.acquireSessionStartLock,
  loadSession: mocks.loadSession,
  releaseSessionStartLock: mocks.releaseSessionStartLock,
  generateAgentBrowserSessionName: mocks.generateAgentBrowserSessionName,
  writeSessionPointer: mocks.writeSessionPointer,
}));

vi.mock('../session/metadata.js', () => ({
  writeMetadata: mocks.writeMetadata,
}));

vi.mock('child_process', () => ({
  execSync: mocks.execSync,
}));

describe('startCommand', () => {
  beforeEach(() => {
    process.exitCode = undefined;
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    mocks.loadConfig.mockReturnValue({
      output: './proofshot-artifacts',
      headless: true,
      viewport: { width: 1280, height: 720 },
      browser: {},
      devServer: {
        port: 3000,
        startupTimeout: 1000,
      },
    });
    mocks.hasActiveSession.mockReturnValue(false);
    mocks.acquireSessionStartLock.mockReturnValue({ path: '/tmp/proofshot-start.lock', token: 'lock-token' });
    mocks.terminateOwnedProcessTree.mockResolvedValue(undefined);
    mocks.generateTimestamp.mockReturnValue('2026-04-08_07-28-00');
    mocks.generateSessionDirName.mockReturnValue('2026-04-08_07-28-00_test');
    mocks.generateAgentBrowserSessionName.mockReturnValue('proofshot-2026-04-08_07-28-00');
    mocks.execSync.mockImplementation((command: string) => {
      if (command === 'git branch --show-current') return 'main';
      if (command === 'git rev-parse HEAD') return 'deadbeef';
      throw new Error(`unexpected command: ${command}`);
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it('closes the browser when recording never starts after all retries', async () => {
    mocks.startRecording.mockImplementation(() => {
      throw new Error('Recording session could not be initialized');
    });

    const commandPromise = startCommand({}).catch((error) => error);
    await vi.runAllTimersAsync();

    await expect(commandPromise).resolves.toMatchObject({ message: 'process.exit:1' });
    expect(mocks.startRecording).toHaveBeenCalledTimes(3);
    expect(mocks.closeBrowser).toHaveBeenCalledTimes(1);
    expect(mocks.saveSession).not.toHaveBeenCalled();
  });

  it('does not try to stop recording when recording never started', async () => {
    mocks.startRecording.mockImplementation(() => {
      throw new Error('Recording already active');
    });

    const commandPromise = startCommand({}).catch((error) => error);
    await vi.runAllTimersAsync();

    await expect(commandPromise).resolves.toMatchObject({ message: 'process.exit:1' });
    expect(mocks.startRecording).toHaveBeenCalledTimes(3);
    expect(mocks.closeBrowser).toHaveBeenCalledTimes(1);
  });

  it('closes the session-scoped browser when browser open fails', async () => {
    mocks.openBrowser.mockImplementation(() => {
      throw new Error('Chrome exited early without writing DevToolsActivePort');
    });

    const commandPromise = startCommand({}).catch((error) => error);

    await expect(commandPromise).resolves.toMatchObject({ message: 'process.exit:1' });
    expect(mocks.closeBrowser).toHaveBeenCalledTimes(1);
    expect(mocks.startRecording).not.toHaveBeenCalled();
    expect(mocks.saveSession).not.toHaveBeenCalled();
  });

  it('records a pointer when a custom output directory is used', async () => {
    mocks.startRecording.mockImplementation(() => {});

    await startCommand({ output: '/tmp/proofshot-low-space' });

    expect(mocks.writeSessionPointer).toHaveBeenCalledWith(
      expect.stringContaining('proofshot-artifacts'),
      '/tmp/proofshot-low-space',
    );
    expect(mocks.abArgs).toHaveBeenCalledWith(
      ['eval', 'window.devicePixelRatio'],
      { session: 'proofshot-2026-04-08_07-28-00' },
    );
    expect(mocks.abArgs).toHaveBeenCalledWith(
      ['eval', 'navigator.userAgent'],
      { session: 'proofshot-2026-04-08_07-28-00' },
    );
  });

  it.each([
    ['default', (root: string, defaultRoot: string) => root === defaultRoot],
    ['custom', (root: string, _defaultRoot: string, customRoot: string) => root === customRoot],
  ])('rejects a duplicate session in the %s output directory before startup', async (_label, isActive) => {
    const defaultRoot = path.resolve('./proofshot-artifacts');
    const customRoot = '/tmp/proofshot-custom-output';
    mocks.hasActiveSession.mockImplementation((root: string) => isActive(root, defaultRoot, customRoot));

    await expect(startCommand({ output: customRoot })).resolves.toBe(false);

    expect(process.exitCode).toBe(1);
    expect(mocks.hasActiveSession).toHaveBeenCalledWith(defaultRoot);
    expect(mocks.hasActiveSession).toHaveBeenCalledWith(customRoot);
    expect(mocks.ensureOutputDir).not.toHaveBeenCalled();
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    expect(mocks.releaseSessionStartLock).toHaveBeenCalled();
  });

  it.each(['session state', 'session pointer'])('rolls back every acquired resource when writing %s fails', async (failure) => {
    const serverProcess = {
      pid: 4321,
      startTime: 'Sat Aug 30 12:00:00 2026',
      command: 'node log-pump.js --proofshot-owner=owner',
      ownershipToken: 'owner',
    };
    mocks.ensureDevServer.mockResolvedValue({ pumpPid: 4321, processIdentity: serverProcess });
    if (failure === 'session state') mocks.saveSession.mockImplementation(() => { throw new Error('state write failed'); });
    else mocks.writeSessionPointer.mockImplementation(() => { throw new Error('pointer write failed'); });

    const commandPromise = startCommand({
      output: '/tmp/proofshot-custom-output',
      run: 'pnpm dev',
    }).catch((error) => error);

    await expect(commandPromise).resolves.toMatchObject({ message: 'process.exit:1' });
    expect(mocks.stopRecording).toHaveBeenCalledWith('proofshot-2026-04-08_07-28-00');
    expect(mocks.closeBrowser).toHaveBeenCalledWith('proofshot-2026-04-08_07-28-00');
    expect(mocks.terminateOwnedProcessTree).toHaveBeenCalledWith(serverProcess);
    expect(mocks.clearSession).toHaveBeenCalledWith(path.resolve('./proofshot-artifacts'));
    expect(mocks.clearSession).toHaveBeenCalledWith('/tmp/proofshot-custom-output');
  });
});

describe('git provenance', () => {
  it('preserves the first filename when porcelain status starts with a space', () => {
    expect(parseChangedFiles(' M README.md\n?? new-file.txt\n')).toEqual(['README.md', 'new-file.txt']);
  });

  it('includes untracked file contents in the diff hash', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-provenance-'));
    fs.writeFileSync(path.join(directory, 'new-file.txt'), 'first');
    const first = hashWorkingTreeDiff(Buffer.from('tracked'), ['new-file.txt'], directory);
    fs.writeFileSync(path.join(directory, 'new-file.txt'), 'second');
    const second = hashWorkingTreeDiff(Buffer.from('tracked'), ['new-file.txt'], directory);
    expect(second).not.toBe(first);
  });
});
