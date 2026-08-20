import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findExecutablePath,
  findPidsListeningOnPort,
  killPids,
  terminateProcessTree,
  getShellExecutable,
  parseWindowsNetstatOutput,
  readCommandVersion,
} from './process.js';

describe('getShellExecutable', () => {
  it('uses cmd.exe on Windows when ComSpec is missing', () => {
    expect(getShellExecutable('win32', {})).toBe('cmd.exe');
  });

  it('prefers ComSpec on Windows', () => {
    expect(getShellExecutable('win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })).toBe(
      'C:\\Windows\\System32\\cmd.exe',
    );
  });

  it('falls back to /bin/sh on Unix when SHELL is missing', () => {
    expect(getShellExecutable('linux', {})).toBe('/bin/sh');
  });
});

describe('parseWindowsNetstatOutput', () => {
  it('returns unique listening pids for the requested port', () => {
    const output = `
Proto  Local Address          Foreign Address        State           PID
TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       1234
TCP    [::]:3000              [::]:0                 LISTENING       5678
TCP    127.0.0.1:3000         127.0.0.1:51722        ESTABLISHED     9999
TCP    0.0.0.0:4000           0.0.0.0:0              LISTENING       4321
TCP    [::]:3000              [::]:0                 LISTENING       5678
`;

    expect(parseWindowsNetstatOutput(output, 3000)).toEqual([1234, 5678]);
  });
});

describe('findExecutablePath', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses command -v on Unix-like platforms', () => {
    const execSpy = vi.fn().mockReturnValue('/usr/local/bin/ffmpeg\n');

    expect(findExecutablePath('ffmpeg', 'darwin', execSpy as never)).toBe('/usr/local/bin/ffmpeg');
    expect(execSpy).toHaveBeenCalledWith('command -v ffmpeg', expect.any(Object));
  });
});

describe('readCommandVersion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the first output line from the version command', () => {
    const execSpy = vi.fn().mockReturnValue('ffmpeg version 7.0\nbuilt with clang\n');

    expect(readCommandVersion('ffmpeg', ['--version'], execSpy as never)).toBe('ffmpeg version 7.0');
    expect(execSpy).toHaveBeenCalledWith('ffmpeg --version', expect.any(Object));
  });
});

describe('terminateProcessTree', () => {
  it('uses taskkill /T on Windows, since there are no process groups to signal', () => {
    const execFn = vi.fn().mockReturnValue('');
    const killFn = vi.fn();

    terminateProcessTree(4321, 'win32', execFn as never, killFn);

    expect(execFn).toHaveBeenCalledWith('taskkill /F /T /PID 4321', { stdio: 'pipe' });
    expect(killFn).not.toHaveBeenCalled();
  });

  it('kills the process group on POSIX', () => {
    const execFn = vi.fn();
    const killFn = vi.fn();

    terminateProcessTree(4321, 'linux', execFn as never, killFn);

    expect(killFn).toHaveBeenCalledWith(-4321, 'SIGKILL');
    expect(execFn).not.toHaveBeenCalled();
  });
});

describe('killPids', () => {
  it('batches pids into a single taskkill on Windows', () => {
    const execFn = vi.fn().mockReturnValue('');

    expect(killPids([1, 2], 'win32', execFn as never)).toBe(true);
    expect(execFn).toHaveBeenCalledWith('taskkill /F /T /PID 1 /PID 2', { stdio: 'pipe' });
  });

  it('uses kill -9 on POSIX', () => {
    const execFn = vi.fn().mockReturnValue('');

    expect(killPids([1, 2], 'linux', execFn as never)).toBe(true);
    expect(execFn).toHaveBeenCalledWith('kill -9 1 2', { stdio: 'pipe' });
  });

  it('reports failure instead of throwing when the kill command fails', () => {
    const execFn = vi.fn().mockImplementation(() => {
      throw new Error('no such process');
    });

    expect(killPids([1], 'win32', execFn as never)).toBe(false);
  });

  it('is a no-op for an empty pid list', () => {
    const execFn = vi.fn();
    expect(killPids([], 'win32', execFn as never)).toBe(false);
    expect(execFn).not.toHaveBeenCalled();
  });
});

describe('findPidsListeningOnPort', () => {
  it('parses netstat output on Windows', () => {
    const execFn = vi.fn().mockReturnValue(
      'TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       1234\n',
    );

    expect(findPidsListeningOnPort(3000, 'win32', execFn as never)).toEqual([1234]);
    expect(execFn).toHaveBeenCalledWith('netstat -ano -p tcp', expect.anything());
  });

  it('parses lsof output on POSIX', () => {
    const execFn = vi.fn().mockReturnValue('111\n222\n');

    expect(findPidsListeningOnPort(3000, 'linux', execFn as never)).toEqual([111, 222]);
    expect(execFn).toHaveBeenCalledWith('lsof -ti:3000', expect.anything());
  });

  it('returns no pids when the lookup command is unavailable', () => {
    const execFn = vi.fn().mockImplementation(() => {
      throw new Error('lsof: command not found');
    });

    expect(findPidsListeningOnPort(3000, 'linux', execFn as never)).toEqual([]);
  });
});
