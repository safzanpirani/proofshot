import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  execFileSync: execFileSyncMock,
}));

import { buildManifest, getActionLogIssues, markdownCodeBlock, trimVideo, validateVideo } from './stop.js';
import type { SessionLogEntry } from './exec.js';

const tempDirs: string[] = [];

function createVideo(contents = 'original-video'): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-stop-test-'));
  tempDirs.push(tempDir);
  const videoPath = path.join(tempDir, 'session.webm');
  fs.writeFileSync(videoPath, contents);
  return videoPath;
}

function action(overrides: Partial<SessionLogEntry> = {}): SessionLogEntry {
  return {
    action: 'click button',
    relativeTimeSec: 8,
    timestamp: '2026-01-01T00:00:08.000Z',
    startedAt: '2026-01-01T00:00:08.000Z',
    finishedAt: '2026-01-01T00:00:20.000Z',
    exitStatus: 0,
    success: true,
    ...overrides,
  };
}

beforeEach(() => execFileSyncMock.mockReset());
afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('validateVideo', () => {
  it('requires a finite positive duration and a video stream', () => {
    const videoPath = createVideo();
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify({ format: { duration: '0' }, streams: [{ codec_type: 'video' }] }))
      .mockReturnValueOnce(JSON.stringify({ format: { duration: 'Infinity' }, streams: [{ codec_type: 'video' }] }))
      .mockReturnValueOnce(JSON.stringify({ format: { duration: '2.5' }, streams: [{ codec_type: 'audio' }] }))
      .mockReturnValueOnce(JSON.stringify({ format: { duration: '2.5' }, streams: [{ codec_type: 'video' }] }));

    expect(validateVideo(videoPath)).toMatchObject({ available: false, reason: expect.stringMatching(/duration/) });
    expect(validateVideo(videoPath)).toMatchObject({ available: false, reason: expect.stringMatching(/duration/) });
    expect(validateVideo(videoPath)).toMatchObject({ available: false, reason: expect.stringMatching(/video stream/) });
    expect(validateVideo(videoPath)).toEqual({ available: true, reason: '', durationSec: 2.5 });
  });

  it('rejects missing and empty files before probing', () => {
    const videoPath = createVideo('');
    expect(validateVideo(videoPath).available).toBe(false);
    fs.unlinkSync(videoPath);
    expect(validateVideo(videoPath).available).toBe(false);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});

describe('getActionLogIssues', () => {
  it('includes malformed JSONL and failed non-assertion actions', () => {
    const result = getActionLogIssues({
      entries: [
        action({ success: false, exitStatus: 1 }),
        action({ success: false, exitStatus: 1, assertion: { type: 'visible', passed: false, message: 'missing' } }),
      ],
      malformedLines: [2, 5],
    });

    expect(result.failedActionCount).toBe(1);
    expect(result.reasons).toEqual([
      'Session action log contains malformed JSONL at line(s) 2, 5',
      '1 non-assertion action(s) failed',
    ]);
  });
});

describe('buildManifest', () => {
  it('always points consumers to result.json', () => {
    expect(buildManifest('/tmp/proofshot/session-one', ['step.png'])).toMatchObject({
      session: 'session-one',
      screenshots: ['step.png'],
      resultFile: 'result.json',
      assertionsFile: 'result.json',
    });
  });
});

describe('markdownCodeBlock', () => {
  it('uses a longer fence than any backtick run in page-controlled logs', () => {
    const block = markdownCodeBlock('Error\n```\n## forged success');
    expect(block.startsWith('````\n')).toBe(true);
    expect(block.endsWith('\n````')).toBe(true);
  });
});

describe('trimVideo', () => {
  it('uses the last action finish time for the trim end', () => {
    const videoPath = createVideo();
    execFileSyncMock.mockImplementation((command: string, args: readonly string[]) => {
      if (command === 'ffmpeg' && args[0] === '-version') return Buffer.from('ffmpeg');
      if (command === 'ffmpeg') {
        fs.writeFileSync(args[args.length - 1], 'trimmed-video');
        return Buffer.from('');
      }
      if (command === 'ffprobe') {
        if (args.includes('-skip_frame')) return '0\n3\n12.8\n';
        return JSON.stringify({ format: { duration: '20' }, streams: [{ codec_type: 'video' }] });
      }
      return Buffer.from('');
    });

    expect(trimVideo(videoPath, [], path.dirname(videoPath), Date.parse('2026-01-01T00:00:00.000Z'), [action()])).toBe(3);
    const ffmpegCall = execFileSyncMock.mock.calls.find(
      ([command, args]) => command === 'ffmpeg' && Array.isArray(args) && args[0] === '-ss',
    );
    expect(ffmpegCall?.[1]).toEqual(expect.arrayContaining(['-ss', '3.00', '-to', '23.00']));
    expect(ffmpegCall?.[1]).toContain('23.00');
  });

  it('falls back to the first keyframe when none precedes the requested start', () => {
    const videoPath = createVideo();
    execFileSyncMock.mockImplementation((command: string, args: readonly string[]) => {
      if (command === 'ffmpeg' && args[0] === '-version') return Buffer.from('ffmpeg');
      if (command === 'ffmpeg') {
        fs.writeFileSync(args[args.length - 1], 'trimmed-video');
        return Buffer.from('');
      }
      if (command === 'ffprobe') {
        if (args.includes('-skip_frame')) return '12.8\n';
        return JSON.stringify({ format: { duration: '10' }, streams: [{ codec_type: 'video' }] });
      }
      return Buffer.from('');
    });

    expect(trimVideo(videoPath, [], path.dirname(videoPath), Date.parse('2026-01-01T00:00:00.000Z'), [action()])).toBe(0);
    const ffmpegCall = execFileSyncMock.mock.calls.find(
      ([command, args]) => command === 'ffmpeg' && Array.isArray(args) && args[0] === '-ss',
    );
    expect(ffmpegCall?.[1]).toEqual(expect.arrayContaining(['-ss', '0.00', '-to', '23.00']));
  });

  it('deletes partial trim output and restores the original on failure', () => {
    const videoPath = createVideo();
    execFileSyncMock.mockImplementation((command: string, args: readonly string[]) => {
      if (command === 'ffmpeg' && args[0] === '-version') return Buffer.from('ffmpeg');
      if (command === 'ffmpeg') {
        fs.writeFileSync(args[args.length - 1], 'partial-video');
        throw new Error('conversion failed');
      }
      return Buffer.from('');
    });

    expect(trimVideo(videoPath, [], path.dirname(videoPath), Date.parse('2026-01-01T00:00:00.000Z'), [action()])).toBe(0);
    expect(fs.readFileSync(videoPath, 'utf-8')).toBe('original-video');
    expect(fs.readdirSync(path.dirname(videoPath))).toEqual(['session.webm']);
  });
});
