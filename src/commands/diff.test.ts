import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { diffCommand } from './diff.js';

describe('diffCommand', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('fails closed when an image comparison is unavailable', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-diff-command-'));
    const baseline = path.join(directory, 'baseline');
    const current = path.join(directory, 'current');
    fs.mkdirSync(baseline);
    fs.mkdirSync(current);
    for (const target of [baseline, current]) {
      fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({ screenshots: ['page.png'] }));
      fs.writeFileSync(path.join(target, 'page.png'), 'invalid png');
    }
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message = '') => output.push(String(message)));

    await diffCommand({ baseline, current });

    expect(process.exitCode).toBe(1);
    expect(output.join('\n')).toContain('Visual comparison failed');
    expect(output.join('\n')).not.toContain('No visual changes detected');
  });
});
