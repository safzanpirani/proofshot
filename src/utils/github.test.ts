import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatPRComment } from '../artifacts/pr-format.js';
import { getGitHubToken, uploadAsset } from './github.js';

describe('getGitHubToken', () => {
  afterEach(() => {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  it('prefers GH_TOKEN from the environment', () => {
    process.env.GH_TOKEN = ' env-token ';

    expect(getGitHubToken()).toBe('env-token');
  });
});

describe('uploadAsset', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('surfaces a targeted message for auth-related web attachment failures', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-github-test-'));
    const filePath = path.join(tmpDir, 'step.png');
    fs.writeFileSync(filePath, 'test');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('unprocessable entity', {
          status: 422,
        }),
      ),
    );

    await expect(uploadAsset(filePath, 'token', 1)).rejects.toThrow(
      /github-web-attachments|repo-contents|GH_TOKEN/,
    );
  });
});

describe('formatPRComment', () => {
  it('renders repo-contents videos as links', () => {
    const body = formatPRComment({
      description: 'Verify checkout',
      sessionCount: 1,
      screenshots: new Map([['step.png', 'https://example.com/step.png']]),
      video: {
        url: 'https://example.com/session.mp4',
        renderMode: 'link',
      },
      errorCount: 0,
      verificationStatus: 'passed',
      assertionFailureCount: 0,
      failedActionCount: 0,
      incompleteReasons: [],
      branch: 'feature/test',
      commitSha: 'abcdef123456',
    });

    expect(body).toContain('[Session recording](https://example.com/session.mp4)');
    expect(body).not.toContain('\nhttps://example.com/session.mp4\n');
  });

  it('reports assertion and evidence failures instead of a green no-error status', () => {
    const body = formatPRComment({
      description: null,
      sessionCount: 1,
      screenshots: new Map(),
      video: null,
      errorCount: 0,
      verificationStatus: 'failed',
      assertionFailureCount: 1,
      failedActionCount: 2,
      incompleteReasons: ['session: Video file was not produced'],
      branch: 'feature/test',
      commitSha: 'abcdef123456',
    });

    expect(body).toContain('❌ Verification failed');
    expect(body).toContain('1 assertion failure(s)');
    expect(body).toContain('2 failed action(s)');
    expect(body).toContain('Video file was not produced');
    expect(body).not.toContain('No errors detected');
  });

  it('escapes untrusted descriptions, evidence reasons, and screenshot labels', () => {
    const body = formatPRComment({
      description: '</blockquote>\n## forged success',
      sessionCount: 1,
      screenshots: new Map([['step-](javascript:alert(1)).png', 'https://example.com/image.png']]),
      video: null,
      errorCount: 0,
      verificationStatus: 'failed',
      assertionFailureCount: 0,
      failedActionCount: 0,
      incompleteReasons: ['</li>\n## forged evidence'],
      branch: 'feature/test',
      commitSha: 'abcdef123456',
    });

    expect(body).not.toContain('</blockquote>');
    expect(body).not.toContain('\n## forged');
    expect(body).not.toContain('](javascript:');
    expect(body).toContain('&lt;/blockquote&gt;');
  });
});
