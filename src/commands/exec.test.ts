import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildShellCommand,
  describeSelectorSyntaxError,
  formatLoggedAction,
  readSessionLog,
  materializeCurlInput,
  resolveScreenshotPath,
} from './exec.js';

describe('buildShellCommand', () => {
  it('routes regular commands through the active ProofShot session', () => {
    expect(buildShellCommand(['click', '@e2'], 'proofshot-2026-04-07_22-30-00')).toBe(
      "agent-browser --session 'proofshot-2026-04-07_22-30-00' click @e2",
    );
  });

  it('preserves eval shell quoting while adding the session flag', () => {
    expect(buildShellCommand(['eval', "console.log('hello')"], 'proofshot-dev')).toBe(
      "agent-browser --session 'proofshot-dev' eval 'console.log('\\''hello'\\'')'",
    );
  });

  it('quotes regular arguments that contain shell metacharacters', () => {
    expect(buildShellCommand(['screenshot', 'step (1).png'], 'proofshot-dev')).toBe(
      "agent-browser --session 'proofshot-dev' screenshot 'step (1).png'",
    );
  });
});

describe('materializeCurlInput', () => {
  it('copies inherited dev-fd cookie input to a child-readable temp file', () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-curl-test-'));
    const sourcePath = path.join(sourceDir, 'cookies.txt');
    fs.writeFileSync(sourcePath, '# Netscape HTTP Cookie File\n');
    const sourceFd = fs.openSync(sourcePath, 'r');

    try {
      const materialized = materializeCurlInput([
        'cookies',
        'set',
        '--curl',
        `/dev/fd/${sourceFd}`,
      ]);
      try {
        expect(materialized.args[3]).not.toBe(`/dev/fd/${sourceFd}`);
        expect(fs.readFileSync(materialized.args[3], 'utf-8')).toContain(
          'Netscape HTTP Cookie File',
        );
      } finally {
        materialized.cleanup();
      }
      expect(fs.existsSync(materialized.args[3])).toBe(false);
    } finally {
      fs.closeSync(sourceFd);
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});

describe('session log safety', () => {
  it('redacts values entered by fill and type actions', () => {
    expect(formatLoggedAction(['fill', '@e2', 'hunter2 with spaces'])).toBe(
      'fill @e2 [REDACTED]',
    );
    expect(formatLoggedAction(['type', 'private message'])).toBe('type [REDACTED]');
    expect(formatLoggedAction(['type', '@e4', 'private message'])).toBe(
      'type @e4 [REDACTED]',
    );
  });

  it('retains valid JSONL records and reports malformed lines', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-jsonl-test-'));
    fs.writeFileSync(path.join(directory, 'session-log.jsonl'), [
      JSON.stringify({ action: 'first', success: true }),
      '{"action":"torn',
      JSON.stringify({ action: 'third', success: false }),
      '',
    ].join('\n'));

    const result = readSessionLog(directory);
    expect(result.entries.map((entry) => entry.action)).toEqual(['first', 'third']);
    expect(result.malformedLines).toEqual([2]);
  });
});

describe('resolveScreenshotPath', () => {
  it('does not rewrite the screenshot command when only flags are present', () => {
    expect(resolveScreenshotPath(['screenshot', '--full'], '/tmp/proofshot-session')).toEqual([
      'screenshot',
      '--full',
    ]);
    expect(resolveScreenshotPath(['screenshot', '--viewport-only'], '/tmp/proofshot-session')).toEqual([
      'screenshot',
    ]);
    expect(resolveScreenshotPath(
      ['screenshot', '--screenshot-format', 'jpeg', '--screenshot-quality', '80'],
      '/tmp/proofshot-session',
    )).toEqual([
      'screenshot',
      '--screenshot-format',
      'jpeg',
      '--screenshot-quality',
      '80',
      '--full',
    ]);
  });

  it('resolves a relative screenshot path without changing flags', () => {
    expect(resolveScreenshotPath(
      ['screenshot', 'step one.png', '--annotate'],
      '/tmp/proofshot-session',
    )).toEqual([
      'screenshot',
      '/tmp/proofshot-session/step one.png',
      '--annotate',
      '--full',
    ]);
  });
});

describe('describeSelectorSyntaxError', () => {
  const notFound = 'Element not found: text=Today. Verify the selector...';

  it('explains Playwright text= syntax and offers the working forms', () => {
    const hint = describeSelectorSyntaxError(['click', 'text=Today'], notFound);
    expect(hint).toContain('Playwright selector syntax');
    expect(hint).toContain('proofshot exec find text Today click');
    expect(hint).toContain('snapshot -i');
  });

  it('says re-navigating will not help, since that is the wrong instinct', () => {
    const hint = describeSelectorSyntaxError(['click', 'text=Today'], notFound);
    expect(hint).toContain('re-navigating will not fix this');
  });

  it('covers the other Playwright engine prefixes', () => {
    for (const selector of ['role=button', 'placeholder=Email', 'testid=submit']) {
      expect(describeSelectorSyntaxError(['fill', selector], notFound)).toContain(
        'Playwright selector syntax',
      );
    }
  });

  it('stays quiet for a CSS selector that genuinely is not on the page', () => {
    expect(describeSelectorSyntaxError(['click', '#missing'], notFound)).toBeNull();
  });

  it('stays quiet when the failure was not a missing element', () => {
    expect(
      describeSelectorSyntaxError(['click', 'text=Today'], 'net::ERR_CONNECTION_REFUSED'),
    ).toBeNull();
  });

  it('stays quiet for commands that do not take a selector', () => {
    expect(describeSelectorSyntaxError(['open', 'text=Today'], notFound)).toBeNull();
  });
});
