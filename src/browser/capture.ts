import { abArgs } from '../utils/exec.js';
import * as fs from 'fs';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/**
 * Start video recording to the given file path.
 */
export function startRecording(outputPath: string, sessionName?: string): void {
  abArgs(['record', 'start', outputPath], { timeoutMs: 10000, session: sessionName });
}

/**
 * Stop the current recording.
 */
export function stopRecording(sessionName?: string): void {
  abArgs(['record', 'stop'], { timeoutMs: 120000, session: sessionName });
}

/**
 * Take a screenshot and save to the given path.
 */
export function takeScreenshot(outputPath: string, fullPage = true, sessionName?: string): void {
  const args = ['screenshot', outputPath];
  if (fullPage) args.push('--full');
  abArgs(args, { timeoutMs: 15000, session: sessionName });
}

/**
 * Take an annotated screenshot (labels interactive elements).
 */
export function takeAnnotatedScreenshot(outputPath: string, sessionName?: string): void {
  abArgs(['screenshot', outputPath, '--annotate'], { timeoutMs: 15000, session: sessionName });
}

/**
 * Compare two screenshots and output a diff image.
 * Returns the mismatch percentage. Throws when either image cannot be compared.
 */
export function diffScreenshots(
  baseline: string,
  current: string,
  outputPath: string,
): number {
  const baselinePng = PNG.sync.read(fs.readFileSync(baseline));
  const currentPng = PNG.sync.read(fs.readFileSync(current));
  const width = Math.max(baselinePng.width, currentPng.width);
  const height = Math.max(baselinePng.height, currentPng.height);
  const overlapWidth = Math.min(baselinePng.width, currentPng.width);
  const overlapHeight = Math.min(baselinePng.height, currentPng.height);
  const baselineData = cropImageData(baselinePng, overlapWidth, overlapHeight);
  const currentData = cropImageData(currentPng, overlapWidth, overlapHeight);
  const overlapDiff = new PNG({ width: overlapWidth, height: overlapHeight });
  const mismatchedPixels = pixelmatch(baselineData, currentData, overlapDiff.data, overlapWidth, overlapHeight, {
    threshold: 0.1,
  });
  if (baselinePng.width === currentPng.width && baselinePng.height === currentPng.height) {
    fs.writeFileSync(outputPath, PNG.sync.write(overlapDiff));
    return (mismatchedPixels / (width * height)) * 100;
  }

  // Added/removed canvas is a change even when it is blank white. Compare only
  // the shared area, then mark pixels present in exactly one screenshot.
  const diff = new PNG({ width, height });
  PNG.bitblt(overlapDiff, diff, 0, 0, overlapWidth, overlapHeight, 0, 0);
  for (let row = 0; row < height; row++) {
    for (let column = row < overlapHeight ? overlapWidth : 0; column < width; column++) {
      if ((column < baselinePng.width && row < baselinePng.height) ||
        (column < currentPng.width && row < currentPng.height)) {
        diff.data.set([255, 0, 0, 255], (row * width + column) * 4);
      }
    }
  }
  const overlapArea = overlapWidth * overlapHeight;
  const unionArea = baselinePng.width * baselinePng.height + currentPng.width * currentPng.height - overlapArea;
  fs.writeFileSync(outputPath, PNG.sync.write(diff));
  return ((mismatchedPixels + unionArea - overlapArea) / unionArea) * 100;
}

function cropImageData(image: PNG, width: number, height: number): Buffer {
  if (image.width === width && image.height === height) return image.data;
  const data = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    image.data.copy(data, row * width * 4, row * image.width * 4, (row * image.width + width) * 4);
  }
  return data;
}
