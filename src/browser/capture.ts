import { ab } from '../utils/exec.js';
import * as fs from 'fs';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/**
 * Start video recording to the given file path.
 */
export function startRecording(outputPath: string, sessionName?: string): void {
  ab(`record start ${outputPath}`, { timeoutMs: 10000, session: sessionName });
}

/**
 * Stop the current recording.
 */
export function stopRecording(sessionName?: string): void {
  ab('record stop', { timeoutMs: 120000, session: sessionName });
}

/**
 * Take a screenshot and save to the given path.
 */
export function takeScreenshot(outputPath: string, fullPage = true, sessionName?: string): void {
  const fullFlag = fullPage ? ' --full' : '';
  ab(`screenshot ${outputPath}${fullFlag}`, { timeoutMs: 15000, session: sessionName });
}

/**
 * Take an annotated screenshot (labels interactive elements).
 */
export function takeAnnotatedScreenshot(outputPath: string, sessionName?: string): void {
  ab(`screenshot ${outputPath} --annotate`, { timeoutMs: 15000, session: sessionName });
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
  const baselineData = normalizeImageSize(baselinePng, width, height);
  const currentData = normalizeImageSize(currentPng, width, height);
  const diff = new PNG({ width, height });
  const mismatchedPixels = pixelmatch(baselineData, currentData, diff.data, width, height, {
    threshold: 0.1,
  });
  fs.writeFileSync(outputPath, PNG.sync.write(diff));
  return (mismatchedPixels / (width * height)) * 100;
}

function normalizeImageSize(image: PNG, width: number, height: number): Buffer {
  if (image.width === width && image.height === height) return image.data;
  const data = Buffer.alloc(width * height * 4, 255);
  for (let row = 0; row < image.height; row += 1) {
    image.data.copy(data, row * width * 4, row * image.width * 4, (row + 1) * image.width * 4);
  }
  return data;
}
