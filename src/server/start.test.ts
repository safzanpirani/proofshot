import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readStartupLogTail } from './start.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('startup log diagnostics', () => {
  it('keeps the last 20 lines and removes timestamp prefixes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-log-tail-'));
    directories.push(directory);
    const log = path.join(directory, 'server.log');
    fs.writeFileSync(log, Array.from({ length: 30 }, (_, i) => `1234567890\tline ${i}\n`).join(''));
    const lines = readStartupLogTail(log).split('\n');
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe('line 10');
    expect(lines.at(-1)).toBe('line 29');
  });

  it('bounds oversized output and keeps the final diagnostic', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-log-tail-'));
    directories.push(directory);
    const log = path.join(directory, 'server.log');
    fs.writeFileSync(log, `123\t${'x'.repeat(20000)}\n123\tstartup failed\n`);
    expect(readStartupLogTail(log)).toBe('startup failed');
  });

  it('allows the original startup error to survive a missing log', () => {
    expect(readStartupLogTail('/nonexistent/proofshot/server.log')).toBe('');
  });
});
