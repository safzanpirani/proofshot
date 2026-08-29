import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import { diffScreenshots, stopRecording } from './capture.js';

const mocks = vi.hoisted(() => ({ ab: vi.fn() }));
vi.mock('../utils/exec.js', () => ({ ab: mocks.ab }));

function writePng(filePath: string, color: [number, number, number, number]): void {
  const png = new PNG({ width: 2, height: 2 });
  for (let offset = 0; offset < png.data.length; offset += 4) png.data.set(color, offset);
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

describe('diffScreenshots', () => {
  it('compares two image files without an active browser session', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-diff-'));
    const baseline = path.join(directory, 'baseline.png');
    const current = path.join(directory, 'current.png');
    const output = path.join(directory, 'diff.png');
    writePng(baseline, [255, 255, 255, 255]);
    writePng(current, [0, 0, 0, 255]);

    expect(diffScreenshots(baseline, current, output)).toBe(100);
    expect(fs.statSync(output).size).toBeGreaterThan(0);
  });

  it('throws when an image cannot be decoded', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-diff-invalid-'));
    const invalid = path.join(directory, 'invalid.png');
    fs.writeFileSync(invalid, 'not a png');
    expect(() => diffScreenshots(invalid, invalid, path.join(directory, 'diff.png'))).toThrow();
  });
});

describe('stopRecording', () => {
  it('allows slow browser video finalization to complete', () => {
    stopRecording('proofshot-test');
    expect(mocks.ab).toHaveBeenCalledWith('record stop', {
      timeoutMs: 120000,
      session: 'proofshot-test',
    });
  });
});
