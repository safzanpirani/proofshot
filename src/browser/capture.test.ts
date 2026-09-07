import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import { diffScreenshots, stopRecording, takeScreenshot } from './capture.js';

const mocks = vi.hoisted(() => ({ abArgs: vi.fn() }));
vi.mock('../utils/exec.js', () => ({ abArgs: mocks.abArgs }));

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

  it.each([
    [[2, 2], [2, 3], 100 / 3],
    [[2, 3], [2, 2], 100 / 3],
    [[2, 3], [3, 2], 50],
  ] as const)('counts blank canvas changes from %s to %s', (before, after, expected) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-diff-resize-'));
    try {
      const baseline = path.join(directory, 'baseline.png');
      const current = path.join(directory, 'current.png');
      const output = path.join(directory, 'diff.png');
      for (const [file, [width, height]] of [[baseline, before], [current, after]] as const) {
        const png = new PNG({ width, height });
        png.data.fill(255);
        fs.writeFileSync(file, PNG.sync.write(png));
      }
      expect(diffScreenshots(baseline, current, output)).toBeCloseTo(expected);
      const diff = PNG.sync.read(fs.readFileSync(output));
      expect([diff.width, diff.height]).toEqual([Math.max(before[0], after[0]), Math.max(before[1], after[1])]);
      expect([...diff.data.subarray(0, 4)]).not.toEqual([255, 0, 0, 255]);
      const changedPixel = before[0] === after[0] ? 2 * diff.width * 4 : 2 * 4;
      expect([...diff.data.subarray(changedPixel, changedPixel + 4)]).toEqual([255, 0, 0, 255]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('stopRecording', () => {
  it('allows slow browser video finalization to complete', () => {
    stopRecording('proofshot-test');
    expect(mocks.abArgs).toHaveBeenCalledWith(['record', 'stop'], {
      timeoutMs: 120000,
      session: 'proofshot-test',
    });
  });

  it('passes screenshot paths as one argument', () => {
    takeScreenshot('C:\\Proof Shots\\step & one.png', true, 'proofshot-test');
    expect(mocks.abArgs).toHaveBeenCalledWith(
      ['screenshot', 'C:\\Proof Shots\\step & one.png', '--full'],
      { timeoutMs: 15000, session: 'proofshot-test' },
    );
  });
});
