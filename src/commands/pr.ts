import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';
import chalk from 'chalk';
import { loadConfig } from '../utils/config.js';
import {
  type GitHubUploadProvider,
  getGitHubToken,
  getRepoInfo,
  getPRNumber,
  uploadAssets,
  postPRComment,
} from '../utils/github.js';
import { findSessionsForBranch, loadMetadata } from '../session/metadata.js';
import { formatPRComment, type PRCommentData } from '../artifacts/pr-format.js';

interface PROptions {
  prNumber?: string;
  dryRun?: boolean;
  uploadProvider?: GitHubUploadProvider;
  artifactsBranch?: string;
  session?: string;
  sha?: string;
  allSessions?: boolean;
  allowStale?: boolean;
  allowDirty?: boolean;
}

export type VerificationStatus = 'passed' | 'failed' | 'unknown';

export interface SessionVerificationResult {
  status: VerificationStatus;
  errorCount: number;
  assertionFailureCount: number;
  failedActionCount: number;
  reasons: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Read the machine-readable verification result without inferring status from prose. */
export function readSessionVerificationResult(sessionDir: string): SessionVerificationResult {
  const resultPath = path.join(sessionDir, 'result.json');
  const unknown = (reason: string): SessionVerificationResult => ({
    status: 'unknown',
    errorCount: 0,
    assertionFailureCount: 0,
    failedActionCount: 0,
    reasons: [reason],
  });

  if (!fs.existsSync(resultPath)) {
    return unknown('Structured result.json is missing. This session may predate structured verification results.');
  }

  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
  } catch (error) {
    return unknown(`Structured result.json is invalid: ${error instanceof Error ? error.message : error}`);
  }
  if (!isRecord(value)) return unknown('Structured result.json does not contain an object.');

  const assertionsAreValid = Array.isArray(value.assertions) && value.assertions.every(
    (assertion) => isRecord(assertion) && typeof assertion.passed === 'boolean',
  );
  const assertions = Array.isArray(value.assertions) ? value.assertions : [];
  const assertionFailureCount = assertions.filter(
    (assertion) => !isRecord(assertion) || assertion.passed !== true,
  ).length;
  const consoleResult = isRecord(value.console) ? nonNegativeInteger(value.console.errorCount) : null;
  const serverResult = isRecord(value.server) ? nonNegativeInteger(value.server.errorCount) : null;
  const actionsResult = isRecord(value.actions) ? nonNegativeInteger(value.actions.failedCount) : null;
  const sessionLogResult = isRecord(value.sessionLog) ? value.sessionLog : null;
  const malformedLinesValue = sessionLogResult?.malformedLines;
  const malformedLines = Array.isArray(malformedLinesValue) && malformedLinesValue.every(
    (line) => typeof line === 'number' && Number.isInteger(line) && line >= 1,
  ) ? malformedLinesValue as number[] : null;
  const errorCount = (consoleResult || 0) + (serverResult || 0);
  const failedActionCount = actionsResult || 0;
  const reasonsAreValid = Array.isArray(value.incompleteReasons) && value.incompleteReasons.every(
    (reason) => typeof reason === 'string',
  );
  const reasons = Array.isArray(value.incompleteReasons)
    ? value.incompleteReasons.filter((reason): reason is string => typeof reason === 'string' && reason.length > 0)
    : [];
  if (malformedLines && malformedLines.length > 0 && !reasons.some((reason) => /malformed JSONL/i.test(reason))) {
    reasons.push(`Session action log contains malformed JSONL at line(s) ${malformedLines.join(', ')}`);
  }
  if (value.evidenceComplete === false && reasons.length === 0) {
    reasons.push('Structured result.json marks the evidence as incomplete.');
  }
  const knownFailure =
    assertionFailureCount > 0 ||
    value.assertionsPassed === false ||
    value.evidenceComplete === false ||
    errorCount > 0 ||
    failedActionCount > 0 ||
    reasons.length > 0 ||
    Boolean(malformedLines && malformedLines.length > 0);

  if (value.schemaVersion !== 2) {
    return {
      status: knownFailure ? 'failed' : 'unknown',
      errorCount,
      assertionFailureCount,
      failedActionCount,
      reasons: [
        ...reasons,
        'Legacy result format cannot prove that all evidence and action records were complete.',
      ],
    };
  }

  const schemaIsComplete =
    typeof value.assertionsPassed === 'boolean' &&
    typeof value.evidenceComplete === 'boolean' &&
    assertionsAreValid &&
    reasonsAreValid &&
    consoleResult !== null &&
    serverResult !== null &&
    actionsResult !== null &&
    malformedLines !== null;
  if (!schemaIsComplete) {
    return {
      status: knownFailure ? 'failed' : 'unknown',
      errorCount,
      assertionFailureCount,
      failedActionCount,
      reasons: [...reasons, 'Structured result.json is missing required verification fields.'],
    };
  }

  return {
    status: knownFailure ? 'failed' : 'passed',
    errorCount,
    assertionFailureCount,
    failedActionCount,
    reasons,
  };
}

export async function prCommand(options: PROptions): Promise<void> {
  const config = loadConfig();
  const outputDir = path.resolve(config.output);
  const uploadProvider = normalizeUploadProvider(options.uploadProvider);
  const artifactsBranch = options.artifactsBranch || 'proofshot-artifacts';

  // 1. Determine current branch
  let branch: string;
  try {
    branch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    console.error(chalk.red('✗') + ' Not in a git repository.');
    process.exit(1);
  }

  if (!branch) {
    console.error(chalk.red('✗') + ' Detached HEAD — cannot determine branch.');
    process.exit(1);
  }

  console.log(chalk.dim(`Branch: ${branch}`));

  const headSha = execFileSync('git', ['rev-parse', options.sha || 'HEAD'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const worktreeDirty = Boolean(execSync('git status --porcelain', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim());
  if (worktreeDirty && !options.allowDirty) {
    console.error(chalk.red('✗') + ' Working tree is dirty. Retry with --allow-dirty only when that mismatch is deliberate.');
    process.exit(1);
  }

  // 2. Find session folders for this branch
  let sessionDirs = options.session
    ? [path.resolve(options.session)]
    : findSessionsForBranch(outputDir, branch);
  if (!options.allSessions && !options.session) {
    sessionDirs = sessionDirs.filter((dir) => loadMetadata(dir)?.commitSha === headSha).slice(0, 1);
  }
  for (const dir of sessionDirs) {
    const metadata = loadMetadata(dir);
    if (!metadata) throw new Error(`Session metadata is missing or invalid: ${dir}`);
    if (metadata.commitSha !== headSha && !options.allowStale) {
      throw new Error(`Session ${dir} targets ${metadata.commitSha || 'unknown SHA'}, not ${headSha}. Use --allow-stale to override.`);
    }
    if (metadata.dirty && !options.allowDirty) {
      throw new Error(`Session ${dir} recorded a dirty worktree. Use --allow-dirty to override.`);
    }
  }

  if (sessionDirs.length === 0) {
    console.error(
      chalk.red('✗') +
        ` No ProofShot sessions found for branch "${branch}".\n` +
        chalk.dim('Run "proofshot start" and "proofshot stop" first.'),
    );
    process.exit(1);
  }

  console.log(chalk.dim(`Found ${sessionDirs.length} session(s) for this branch`));

  // 3. Gather artifacts from all sessions (sorted newest first)
  const screenshotPaths: string[] = [];
  let videoPath: string | null = null;
  let errorCount = 0;
  let assertionFailureCount = 0;
  let failedActionCount = 0;
  const verificationStatuses: VerificationStatus[] = [];
  const incompleteReasons: string[] = [];
  let latestCommitSha = '';
  let description: string | null = null;

  for (const sessionDir of sessionDirs) {
    const metadata = loadMetadata(sessionDir);
    if (metadata) {
      if (!description && metadata.description) description = metadata.description;
      if (!latestCommitSha && metadata.commitSha) latestCommitSha = metadata.commitSha;
    }

    const files = fs.readdirSync(sessionDir);

    // Collect screenshots
    for (const f of files) {
      if (f.endsWith('.png')) {
        screenshotPaths.push(path.join(sessionDir, f));
      }
    }

    // Use the most recent video (sessions are newest-first, so only take the first)
    if (!videoPath) {
      for (const f of files) {
        if (f === 'session.webm' || f === 'session.mp4') {
          videoPath = path.join(sessionDir, f);
          break;
        }
      }
    }

    const verification = readSessionVerificationResult(sessionDir);
    verificationStatuses.push(verification.status);
    errorCount += verification.errorCount;
    assertionFailureCount += verification.assertionFailureCount;
    failedActionCount += verification.failedActionCount;
    incompleteReasons.push(
      ...verification.reasons.map((reason) => `${path.basename(sessionDir)}: ${reason}`),
    );
  }

  const verificationStatus: VerificationStatus = verificationStatuses.includes('failed')
    ? 'failed'
    : verificationStatuses.includes('unknown')
      ? 'unknown'
      : 'passed';

  // 4. Convert .webm → .mp4 if ffmpeg is available
  if (videoPath && videoPath.endsWith('.webm')) {
    const mp4Path = videoPath.replace(/\.webm$/, '.mp4');
    if (fs.existsSync(mp4Path)) {
      videoPath = mp4Path;
    } else {
      try {
        execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' });
        console.log(chalk.dim('Converting video to .mp4...'));
        execFileSync('ffmpeg', [
          '-i', videoPath,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-an',
          mp4Path,
        ], { stdio: 'pipe', timeout: 120000 });
        videoPath = mp4Path;
        console.log(chalk.green('✓') + ' Video converted to .mp4');
      } catch {
        if (fs.existsSync(mp4Path)) fs.unlinkSync(mp4Path);
        console.log(chalk.dim('Video conversion unavailable — uploading .webm directly'));
      }
    }
  }

  // 5. For --dry-run, generate markdown with placeholder URLs (no GitHub dependency)
  if (options.dryRun) {
    const screenshotMap = new Map<string, string>();
    for (const ssPath of screenshotPaths) {
      const label = screenshotLabel(ssPath);
      screenshotMap.set(label, `https://github.com/user-attachments/assets/<${label}>`);
    }

    const commentData: PRCommentData = {
      description,
      sessionCount: sessionDirs.length,
      screenshots: screenshotMap,
      video: videoPath
        ? {
            url: `https://github.com/user-attachments/assets/<${path.basename(videoPath)}>`,
            renderMode: 'embed',
          }
        : null,
      errorCount,
      verificationStatus,
      assertionFailureCount,
      failedActionCount,
      incompleteReasons,
      branch,
      commitSha: latestCommitSha,
    };

    console.log('');
    console.log(chalk.yellow('--- Dry run (not posted) ---'));
    console.log(formatPRComment(commentData));
    return;
  }

  // 6. Resolve PR number (requires gh CLI)
  const prNumber = getPRNumber(options.prNumber);
  console.log(chalk.dim(`Target PR: #${prNumber}`));

  // 7. Authenticate and get repo info
  const token = getGitHubToken();
  const repoInfo = await getRepoInfo(token);

  // 8. Upload artifacts
  const filesToUpload = [...screenshotPaths];
  if (videoPath) filesToUpload.push(videoPath);

  const uploadRoot = buildUploadRoot(branch, prNumber, latestCommitSha);

  console.log(chalk.dim(`Upload provider: ${uploadProvider}`));
  if (uploadProvider === 'repo-contents') {
    console.log(chalk.dim(`Artifacts branch: ${artifactsBranch}`));
  }
  console.log(chalk.dim(`Uploading ${filesToUpload.length} artifact(s)...`));

  const uploaded = await uploadAssets({
    filePaths: filesToUpload,
    token,
    repo: repoInfo,
    uploadProvider,
    uploadRoot,
    artifactsBranch,
    onProgress: (current, total, fileName) => {
      console.log(chalk.dim(`  [${current}/${total}] ${fileName}`));
    },
  });

  // Build screenshot URL map using full path as upload key
  const screenshotMap = new Map<string, string>();
  let failedUploads = 0;
  for (const ssPath of screenshotPaths) {
    const asset = uploaded.get(ssPath);
    if (asset) {
      screenshotMap.set(screenshotLabel(ssPath), asset.url);
    } else {
      failedUploads++;
    }
  }

  // Get video URL
  let video: { url: string; renderMode: 'embed' | 'link' } | null = null;
  if (videoPath) {
    const videoAsset = uploaded.get(videoPath);
    if (videoAsset) {
      video = {
        url: videoAsset.url,
        renderMode: uploadProvider === 'repo-contents' ? 'link' : 'embed',
      };
    }
    else failedUploads++;
  }

  if (failedUploads > 0) {
    console.error(
      chalk.red('✗') +
        ` ${failedUploads} of ${filesToUpload.length} artifact upload(s) failed. PR comment was not posted.\n` +
        chalk.dim(
          uploadProvider === 'github-web-attachments'
            ? 'Retry with "proofshot pr --upload-provider repo-contents" or use "proofshot pr --dry-run".'
            : 'Retry with "proofshot pr --dry-run" to inspect the generated markdown.',
        ),
    );
    process.exitCode = 1;
    return;
  }

  // 9. Generate and post PR comment
  const commentData: PRCommentData = {
    description,
    sessionCount: sessionDirs.length,
    screenshots: screenshotMap,
    video,
    errorCount,
    verificationStatus,
    assertionFailureCount,
    failedActionCount,
    incompleteReasons,
    branch,
    commitSha: latestCommitSha,
  };

  const commentBody = formatPRComment(commentData);

  console.log(chalk.dim('Posting PR comment...'));
  postPRComment(prNumber, commentBody);

  console.log('');
  console.log(chalk.green.bold(`✅ Posted ProofShot verification to PR #${prNumber}`));
  console.log(
    chalk.dim(`  ${screenshotMap.size} screenshot(s), ${video ? '1 video' : 'no video'}`),
  );
}

/**
 * Create a unique label for a screenshot using session folder + filename.
 * Avoids collisions when multiple sessions have identically-named files.
 */
function screenshotLabel(ssPath: string): string {
  const sessionDir = path.basename(path.dirname(ssPath));
  const fileName = path.basename(ssPath);
  return `${sessionDir}/${fileName}`;
}

function buildUploadRoot(branch: string, prNumber: number, commitSha: string): string {
  const sanitizedBranch = branch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'branch';
  const sha = commitSha ? commitSha.slice(0, 7) : 'unknown-sha';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.posix.join('proofshot', `pr-${prNumber}`, sanitizedBranch, `${timestamp}-${sha}`);
}

function normalizeUploadProvider(provider?: string): GitHubUploadProvider {
  if (provider === undefined) return 'repo-contents';
  if (provider === 'repo-contents' || provider === 'github-web-attachments') return provider;

  console.error(
    chalk.red('✗') +
      ` Invalid upload provider "${provider}". Use "repo-contents" or "github-web-attachments".`,
  );
  process.exit(1);
}
