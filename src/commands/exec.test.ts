import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildShellCommand,
  describeSelectorSyntaxError,
  materializeCurlInput,
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
