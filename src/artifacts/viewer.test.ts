import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateViewer, writeViewer } from './viewer.js';
import type { SessionLogEntry } from '../commands/exec.js';

const tempDirs: string[] = [];

function action(actionText: string): SessionLogEntry {
  return {
    action: actionText,
    relativeTimeSec: 1,
    timestamp: '2026-01-01T00:00:01.000Z',
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:00:02.000Z',
    exitStatus: 0,
    success: true,
  };
}

function viewerData(entries: SessionLogEntry[]) {
  return {
    description: null,
    serverCommand: null,
    durationSec: 5,
    videoFilename: 'session.webm',
    entries,
    consoleErrorCount: 0,
    serverErrorCount: 0,
  };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('generateViewer', () => {
  it('embeds marker data safely and builds hover content without innerHTML', () => {
    const malicious = 'click </script><script>globalThis.pwned=1</script>\u2028';
    const html = generateViewer(viewerData([action(malicious)]));

    expect(html).not.toContain('</script><script>globalThis.pwned=1</script>');
    expect(html).toContain('\\u003c/script\\u003e');
    expect(html).not.toContain('scrubTooltip.innerHTML');
    expect(html).toContain('scrubTooltip.replaceChildren(icon, actionText, time)');
  });
});

describe('writeViewer', () => {
  it('reads the current JSONL session log', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-viewer-test-'));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, 'session-log.jsonl'), `${JSON.stringify(action('click current-jsonl'))}\n`);

    const viewerPath = writeViewer(tempDir, {
      description: null,
      serverCommand: null,
      durationSec: 5,
      videoFilename: null,
      consoleErrorCount: 0,
      serverErrorCount: 0,
    });

    expect(viewerPath).toBe(path.join(tempDir, 'viewer.html'));
    expect(fs.readFileSync(viewerPath!, 'utf-8')).toContain('click current-jsonl');
  });
});
