import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import chalk from 'chalk';
import { loadConfig } from '../utils/config.js';
import { setAgentBrowserDefaults } from '../utils/exec.js';
import { closeBrowser, getConsoleErrors, getConsoleOutput, getConsoleOutputJson } from '../browser/session.js';
import { stopRecording } from '../browser/capture.js';
import { loadSession, clearSession, saveSession } from '../session/state.js';
import { terminateOwnedProcessTree } from '../utils/process.js';
import { writeViewer, type TimestampedLogEntry } from '../artifacts/viewer.js';
import { extractServerErrors } from '../utils/error-patterns.js';
import { readSessionLog, type SessionLogReadResult } from './exec.js';
import { estimateTokenUsage, formatTokenUsage, type TokenUsage } from '../utils/token-usage.js';
import { writeJsonAtomic } from '../utils/atomic.js';

/**
 * Parse server.log lines with "epochMs\ttext" format.
 * Returns { entries (with relativeTimeSec), cleanText (timestamps stripped) }.
 */
function parseTimestampedServerLog(
  raw: string,
  startTimeMs: number,
): { entries: TimestampedLogEntry[]; cleanText: string } {
  if (!raw.trim()) return { entries: [], cleanText: '' };

  const lines = raw.split('\n').filter((l) => l.trim());
  const entries: TimestampedLogEntry[] = [];
  const cleanLines: string[] = [];

  for (const line of lines) {
    const tabIdx = line.indexOf('\t');
    if (tabIdx > 0) {
      const epochStr = line.slice(0, tabIdx);
      const epochMs = parseInt(epochStr, 10);
      if (!isNaN(epochMs) && epochMs > 1e12) {
        const text = line.slice(tabIdx + 1);
        entries.push({
          text,
          relativeTimeSec: Math.max(0, parseFloat(((epochMs - startTimeMs) / 1000).toFixed(1))),
        });
        cleanLines.push(text);
        continue;
      }
    }
    // Fallback: line without timestamp prefix
    entries.push({ text: line, relativeTimeSec: -1 });
    cleanLines.push(line);
  }

  return { entries, cleanText: cleanLines.join('\n') };
}

export interface StopOptions {
  noClose?: boolean;
  allowIncomplete?: boolean;
  failOnConsoleErrors?: boolean;
  failOnServerErrors?: boolean;
}

export function getActionLogIssues(log: SessionLogReadResult): {
  failedActionCount: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (log.malformedLines.length > 0) {
    reasons.push(`Session action log contains malformed JSONL at line(s) ${log.malformedLines.join(', ')}`);
  }
  const failedActionCount = log.entries.filter((entry) => !entry.success && !entry.assertion).length;
  if (failedActionCount > 0) reasons.push(`${failedActionCount} non-assertion action(s) failed`);
  return { failedActionCount, reasons };
}

export function buildManifest(sessionDir: string, screenshots: string[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    session: path.basename(sessionDir),
    screenshots,
    resultFile: 'result.json',
    assertionsFile: 'result.json',
    metadataFile: 'metadata.json',
  };
}

export async function stopCommand(options: StopOptions): Promise<void> {
  const config = loadConfig();
  setAgentBrowserDefaults({ configPath: config.browser.configPath });
  const outputDir = path.resolve(config.output);

  // Load session state
  const session = loadSession(outputDir);
  if (!session) {
    console.error(
      chalk.red('✗') +
        ' No active session found.\n' +
        chalk.dim('Run "proofshot start" first.'),
    );
    process.exit(1);
  }

  const startTime = new Date(session.startedAt).getTime();
  const durationMs = Date.now() - startTime;
  const durationSec = Math.round(durationMs / 1000);

  // Step 1: Collect console errors and output
  console.log(chalk.dim('Collecting errors...'));
  let consoleErrors = '';
  let consoleOutput = '';
  let consoleEntries: TimestampedLogEntry[] = [];
  let consoleStatus: 'captured' | 'unavailable' | 'browser-disconnected' = 'captured';
  const incompleteReasons: string[] = [];
  try {
    consoleErrors = getConsoleErrors(session.sessionName);
    consoleOutput = getConsoleOutput(session.sessionName);
    // Get timestamped console messages for viewer sync
    const consoleMessages = getConsoleOutputJson(session.sessionName);
    consoleEntries = consoleMessages.map((msg) => ({
      text: `[${msg.type}] ${msg.text}`,
      relativeTimeSec: Math.max(0, parseFloat(((msg.timestamp - startTime) / 1000).toFixed(1))),
    }));
  } catch (error) {
    consoleStatus = /disconnect|closed|browser/i.test(error instanceof Error ? error.message : String(error))
      ? 'browser-disconnected'
      : 'unavailable';
    incompleteReasons.push(`Console collection ${consoleStatus}: ${error instanceof Error ? error.message : error}`);
  }

  // Write console output to file (before closing browser)
  if (consoleOutput.trim()) {
    fs.writeFileSync(path.join(session.sessionDir, 'console-output.log'), consoleOutput);
  }

  // Step 2: Stop recording
  console.log(chalk.dim('Stopping recording...'));
  const recordingWasActive = session.recordingActive;
  try {
    stopRecording(session.sessionName);
    session.recordingActive = false;
  } catch (error) {
    incompleteReasons.push(`Recording stop failed: ${error instanceof Error ? error.message : error}`);
  }

  // Step 3: Close browser (unless --no-close)
  if (!options.noClose) {
    console.log(chalk.dim('Closing browser...'));
    closeBrowser(session.sessionName);
  }

  // Step 4: Read server log (with timestamp parsing)
  let serverLog = '';
  let serverEntries: TimestampedLogEntry[] = [];
  if (fs.existsSync(session.serverErrorLog)) {
    const rawServerLog = fs.readFileSync(session.serverErrorLog, 'utf-8');
    const parsed = parseTimestampedServerLog(rawServerLog, startTime);
    serverLog = parsed.cleanText;
    serverEntries = parsed.entries;
  }
  const serverStatus: 'captured' | 'unavailable-without-run' | 'unavailable' = session.serverCommand
    ? (fs.existsSync(session.serverErrorLog) ? 'captured' : 'unavailable')
    : 'unavailable-without-run';
  if (serverStatus === 'unavailable') incompleteReasons.push('Server log collection failed because server.log is missing');

  // Use session subfolder for all artifacts
  const sessionDir = session.sessionDir;

  // Step 5: Find all screenshots in session dir
  const screenshots = fs.existsSync(sessionDir)
    ? fs.readdirSync(sessionDir).filter((f) => f.endsWith('.png'))
    : [];

  // Step 5.5: Trim video dead time
  const sessionLogResult = readSessionLog(sessionDir);
  const sessionLog = sessionLogResult.entries;
  const actionLogIssues = getActionLogIssues(sessionLogResult);
  incompleteReasons.push(...actionLogIssues.reasons);
  let trimOffsetSec = 0;
  let videoStatus = validateVideo(session.videoPath);
  if (videoStatus.available) {
    trimOffsetSec = trimVideo(session.videoPath, screenshots, sessionDir, startTime, sessionLog);
    videoStatus = validateVideo(session.videoPath);
    if (!videoStatus.available) incompleteReasons.push(videoStatus.reason);
  } else {
    incompleteReasons.push(videoStatus.reason);
    if (recordingWasActive) {
      console.log(
        chalk.yellow('⚠') +
          ' Recording was active but no valid video file was produced.\n' +
          chalk.dim('  The screencast may have been interrupted. Screenshots and logs are still saved.'),
      );
    }
  }
  const reportDurationSec = videoStatus.available && videoStatus.durationSec !== null
    ? Math.round(videoStatus.durationSec)
    : durationSec;

  // Step 6: Count errors
  // `agent-browser errors` only reports uncaught page exceptions. Explicit
  // console.error() calls arrive as console messages typed "error", and were
  // previously captured to console-output.log but reported as zero.
  const consoleErrorMessages = consoleEntries
    .filter((entry) => entry.text.startsWith('[error]'))
    .map((entry) => entry.text.replace(/^\[error\]\s*/, ''));

  const pageErrorLines = consoleErrors
    .split('\n')
    .filter((l) => l.trim() && l.trim() !== 'No errors');
  const consoleErrorLines = [...pageErrorLines, ...consoleErrorMessages];
  const consoleErrorCount = consoleErrorLines.length;

  // Extract errors from server log using multi-language patterns
  const serverErrorLines = extractServerErrors(serverLog);
  const serverErrorCount = serverErrorLines.length;

  // Step 6.5: Estimate token usage
  const tokenUsage = null;

  const resultPath = path.join(sessionDir, 'result.json');
  let assertionFailures = 0;
  let recordedAssertions: Array<{ passed?: boolean }> = [];
  if (fs.existsSync(resultPath)) {
    try {
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as { assertions?: Array<{ passed?: boolean }> };
      recordedAssertions = result.assertions || [];
      assertionFailures = recordedAssertions.filter((assertion) => !assertion.passed).length;
    } catch (error) {
      incompleteReasons.push(`Assertion results unavailable: ${error instanceof Error ? error.message : error}`);
    }
  }
  writeJsonAtomic(path.join(sessionDir, 'manifest.json'), buildManifest(sessionDir, screenshots));

  // Step 7: Generate SUMMARY.md
  const summaryPath = path.join(sessionDir, 'SUMMARY.md');
  const summaryData: SummaryData = {
    description: session.description,
    serverCommand: session.serverCommand,
    port: session.port,
    videoPath: session.videoPath,
    screenshots,
    consoleErrors: consoleErrorLines.join('\n'),
    consoleErrorCount,
    serverLog,
    serverErrorCount,
    tokenUsage,
    durationSec: reportDurationSec,
    outputDir: sessionDir,
    consoleStatus,
    serverStatus,
    videoStatus: videoStatus.available ? 'captured' : 'unavailable',
    environment: session,
    assertionFailures,
    incompleteReasons,
  };
  fs.writeFileSync(summaryPath, generateProofSummary(summaryData));

  // Step 7.5: Generate interactive viewer (if session log exists)
  // Adjust session log timestamps to match the trimmed video
  const viewerEntries =
    trimOffsetSec > 0
      ? sessionLog.map((e) => ({
          ...e,
          relativeTimeSec: parseFloat((e.relativeTimeSec - trimOffsetSec).toFixed(1)),
        }))
      : sessionLog;

  // Apply trimOffsetSec to log entries (same adjustment as session log)
  const adjustTime = (e: TimestampedLogEntry): TimestampedLogEntry =>
    trimOffsetSec > 0
      ? { ...e, relativeTimeSec: parseFloat((e.relativeTimeSec - trimOffsetSec).toFixed(1)) }
      : e;

  const viewerConsoleEntries = consoleEntries.map(adjustTime);
  const viewerServerEntries = serverEntries.map(adjustTime);

  const viewerPath = writeViewer(sessionDir, {
    description: session.description,
    serverCommand: session.serverCommand,
    durationSec: reportDurationSec,
    videoFilename: videoStatus.available ? path.basename(session.videoPath) : null,
    consoleErrorCount,
    serverErrorCount,
    consoleOutput,
    serverLog,
    consoleEntries: viewerConsoleEntries.length > 0 ? viewerConsoleEntries : undefined,
    serverEntries: viewerServerEntries.length > 0 ? viewerServerEntries : undefined,
    entries: viewerEntries.length > 0 ? viewerEntries : undefined,
    tokenUsage,
  });

  // Step 8: Clear session state
  // Shut down the dev server proofshot started. Previously the process tree was
  // only killed when startup failed, so every completed session leaked a server
  // holding the port -- the next run then had to kill it to get the port back.
  let serverCleanupSafe = true;
  if (session.serverProcess) {
    try {
      await terminateOwnedProcessTree(session.serverProcess);
      console.log(chalk.dim('Dev server stopped'));
    } catch (error) {
      serverCleanupSafe = false;
      incompleteReasons.push(`Dev server cleanup refused: ${error instanceof Error ? error.message : error}`);
    }
  }

  if (serverCleanupSafe) clearSession(outputDir);
  else saveSession(session);
  fs.writeFileSync(summaryPath, generateProofSummary(summaryData));
  writeJsonAtomic(resultPath, {
    schemaVersion: 2,
    assertions: recordedAssertions,
    assertionsPassed: assertionFailures === 0,
    evidenceComplete: incompleteReasons.length === 0,
    actions: { failedCount: actionLogIssues.failedActionCount },
    sessionLog: { malformedLines: sessionLogResult.malformedLines },
    console: { status: consoleStatus, errorCount: consoleErrorCount },
    server: { status: serverStatus, errorCount: serverErrorCount },
    video: {
      status: videoStatus.available ? 'captured' : 'unavailable',
      reason: videoStatus.reason || null,
      durationSec: videoStatus.durationSec,
    },
    incompleteReasons,
  });

  // Step 9: Print results
  console.log('');
  const failed = incompleteReasons.length > 0 || assertionFailures > 0 ||
    Boolean(options.failOnConsoleErrors && consoleErrorCount > 0) ||
    Boolean(options.failOnServerErrors && serverErrorCount > 0);
  console.log((failed ? chalk.red.bold('✗ ProofShot verification incomplete') : chalk.green.bold('✅ ProofShot verification complete')));
  console.log('');

  if (videoStatus.available) {
    console.log(`📹 Video:         ${chalk.dim(session.videoPath)} (${reportDurationSec}s)`);
  }
  console.log(`📸 Screenshots:   ${screenshots.length} captured`);
  console.log(`📝 Summary:       ${chalk.dim(summaryPath)}`);
  if (viewerPath) {
    console.log(`🎬 Viewer:        ${chalk.dim(viewerPath)}`);
  } else {
    console.log(chalk.dim('Tip: Use "proofshot exec" instead of "agent-browser" to get an interactive timeline viewer.'));
  }
  console.log('');
  console.log(
    `Console errors:   ${consoleErrorCount === 0 ? chalk.green('0') : chalk.red(String(consoleErrorCount))}`,
  );
  console.log(
    `Server errors:    ${serverErrorCount === 0 ? chalk.green('0') : chalk.red(String(serverErrorCount))}`,
  );
  console.log(`Duration:         ${reportDurationSec} seconds`);
  console.log(`Evidence:         ${failed ? chalk.red('incomplete') : chalk.green('complete')}`);
  console.log('');
  console.log(`Proof artifacts saved to ${chalk.dim(sessionDir)}`);

  // If errors were found, print them for immediate feedback
  if (consoleErrorCount > 0) {
    console.log('');
    console.log(chalk.red.bold('Console Errors:'));
    for (const line of consoleErrorLines.slice(0, 10)) {
      console.log(chalk.red(`  ${line}`));
    }
    if (consoleErrorLines.length > 10) {
      console.log(chalk.dim(`  ... and ${consoleErrorLines.length - 10} more (see SUMMARY.md)`));
    }
  }

  if (serverErrorCount > 0) {
    console.log('');
    console.log(chalk.red.bold('Server Errors:'));
    for (const line of serverErrorLines.slice(0, 10)) {
      console.log(chalk.red(`  ${line}`));
    }
    if (serverErrorLines.length > 10) {
      console.log(chalk.dim(`  ... and ${serverErrorLines.length - 10} more (see SUMMARY.md)`));
    }
  }
  if (incompleteReasons.length > 0) {
    console.log('');
    console.log(chalk.red.bold('Unavailable evidence:'));
    for (const reason of incompleteReasons) console.log(chalk.red(`  ${reason}`));
  }
  if (failed && !options.allowIncomplete) process.exitCode = 1;
}

interface SummaryData {
  description: string | null;
  serverCommand: string | null;
  port: number;
  videoPath: string;
  screenshots: string[];
  consoleErrors: string;
  consoleErrorCount: number;
  serverLog: string;
  serverErrorCount: number;
  tokenUsage?: TokenUsage | null;
  durationSec: number;
  outputDir: string;
  consoleStatus: 'captured' | 'unavailable' | 'browser-disconnected';
  serverStatus: 'captured' | 'unavailable-without-run' | 'unavailable';
  videoStatus: 'captured' | 'unavailable';
  environment: import('../session/state.js').SessionState;
  assertionFailures: number;
  incompleteReasons: string[];
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]{}()#+\-.!|])/g, '\\$1')
    .replace(/\r?\n/g, ' ');
}

export function markdownCodeBlock(value: string): string {
  const longestRun = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${value}\n${fence}`;
}

function markdownLocalLink(filename: string): string {
  return `./${encodeURIComponent(filename)}`;
}

function generateProofSummary(data: SummaryData): string {
  const date = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const projectName = path.basename(process.cwd());

  let md = `# ProofShot Verification Report

**Date:** ${date}
**Project:** ${escapeMarkdownText(projectName)}
**Dev Server:** ${escapeMarkdownText(data.serverCommand || 'external')} on localhost:${data.port}

`;

  if (data.description) {
    md += `## What Was Verified

${escapeMarkdownText(data.description)}

`;
  }

  // Video
  const relativeVideo = path.basename(data.videoPath);
  md += `## Video Recording\n\n${data.videoStatus === 'captured' ? `Full session recording: [${escapeMarkdownText(relativeVideo)}](${markdownLocalLink(relativeVideo)}) (${data.durationSec}s)` : 'Video capture unavailable.'}\n\n`;

  // Screenshots
  if (data.screenshots.length > 0) {
    md += `## Screenshots

`;
    for (const ss of data.screenshots) {
      md += `![${escapeMarkdownText(ss)}](${markdownLocalLink(ss)})\n\n`;
    }
  }

  // Console errors
  md += `## Console Errors

`;
  if (data.consoleStatus !== 'captured') {
    md += `Console collection ${data.consoleStatus}.\n\n`;
  } else if (data.consoleErrorCount === 0) {
    md += `No console errors detected.\n\n`;
  } else {
    md += `${data.consoleErrorCount} error(s) detected:\n\n${markdownCodeBlock(data.consoleErrors)}\n\n`;
  }

  // Server errors
  md += `## Server Errors

`;
  if (data.serverStatus === 'unavailable-without-run') {
    md += `Server logs unavailable because --run was omitted.\n\n`;
  } else if (data.serverStatus === 'unavailable') {
    md += `Server log collection unavailable.\n\n`;
  } else if (data.serverErrorCount === 0) {
    md += `No server errors detected.\n\n`;
  } else {
    md += `${data.serverErrorCount} error(s) detected:\n\n${markdownCodeBlock(data.serverLog.slice(0, 5000))}\n\n`;
    if (data.serverLog.length > 5000) {
      md += `_(truncated — see server.log for full output)_\n\n`;
    }
  }

  if (data.tokenUsage) {
    md += `## Token Usage (Estimated)\n\n`;
    md += formatTokenUsage(data.tokenUsage);
    md += '\n';
  }

  md += `## Assertions\n\n${data.assertionFailures === 0 ? 'All recorded assertions passed.' : `${data.assertionFailures} required assertion(s) failed.`}\n\n`;

  if (data.incompleteReasons.length > 0) {
    md += `## Unavailable Evidence\n\n${data.incompleteReasons.map((reason) => `- ${escapeMarkdownText(reason)}`).join('\n')}\n\n`;
  }

  md += `## Environment
- Browser mode: ${data.environment.headless ? 'headless' : 'headed'}
- Browser: ${escapeMarkdownText(data.environment.browserVersion || 'unavailable')}
- agent-browser: ${escapeMarkdownText(data.environment.agentBrowserVersion || 'unavailable')}
- Initial viewport: ${data.environment.initialViewport.width}x${data.environment.initialViewport.height}
- Final viewport: ${data.environment.viewport?.width || 'unavailable'}x${data.environment.viewport?.height || 'unavailable'}
- Device scale factor: ${data.environment.deviceScaleFactor}
- ProofShot commit: ${escapeMarkdownText(data.environment.proofshotCommit || 'unavailable')}
- Duration: ${data.durationSec} seconds
`;

  return md;
}

export function validateVideo(videoPath: string): { available: boolean; reason: string; durationSec: number | null } {
  if (!fs.existsSync(videoPath)) return { available: false, reason: 'Video file was not produced', durationSec: null };
  const size = fs.statSync(videoPath).size;
  if (size === 0) return { available: false, reason: 'Video file is empty', durationSec: null };
  try {
    const output = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type',
      '-of', 'json',
      videoPath,
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });

    const probe = JSON.parse(output) as {
      format?: { duration?: unknown };
      streams?: Array<{ codec_type?: unknown }>;
    };
    const duration = Number(probe.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      return { available: false, reason: 'Video has no finite positive duration', durationSec: null };
    }
    if (!Array.isArray(probe.streams) || !probe.streams.some((stream) => stream.codec_type === 'video')) {
      return { available: false, reason: 'File contains no video stream', durationSec: null };
    }
    return { available: true, reason: '', durationSec: duration };
  } catch (error) {
    return {
      available: false,
      reason: `Video integrity check failed: ${error instanceof Error ? error.message : error}`,
      durationSec: null,
    };
  }
}

/**
 * Trim dead time from the beginning and end of the session video.
 *
 * Prefers session log timestamps (from `proofshot exec`) when available — these
 * give exact relative times for every action. Falls back to screenshot file
 * birth times when there's no session log.
 *
 * Buffers: 5s before first action, 3s after last action.
 */
export function trimVideo(
  videoPath: string,
  screenshots: string[],
  outputDir: string,
  recordingStartMs: number,
  sessionLog: import('./exec.js').SessionLogEntry[],
): number {
  let firstActionSec: number | null = null;
  let lastActionSec: number | null = null;

  // Prefer session log timestamps (precise, not affected by stale files)
  if (sessionLog.length > 0) {
    const actionStarts = sessionLog.map((entry) => entry.relativeTimeSec);
    const actionFinishes = sessionLog.map((entry) => {
      const finishedAtMs = new Date(entry.finishedAt).getTime();
      return Number.isFinite(finishedAtMs) ? (finishedAtMs - recordingStartMs) / 1000 : null;
    });
    if (actionStarts.some((time) => !Number.isFinite(time)) || actionFinishes.some((time) => time === null)) {
      console.log(chalk.dim('Video trimming skipped because the action log lacks reliable finish times.'));
      return 0;
    }
    firstActionSec = Math.min(...actionStarts);
    lastActionSec = Math.max(...actionFinishes as number[]);
  } else if (screenshots.length > 0) {
    // Fallback: use screenshot file birth times (only files created AFTER session start)
    const timestamps = screenshots
      .map((f) => {
        try {
          return fs.statSync(path.join(outputDir, f)).birthtimeMs;
        } catch {
          return null;
        }
      })
      .filter((t): t is number => t !== null && t >= recordingStartMs);

    if (timestamps.length === 0) return 0;

    firstActionSec = (Math.min(...timestamps) - recordingStartMs) / 1000;
    lastActionSec = (Math.max(...timestamps) - recordingStartMs) / 1000;
  }

  if (firstActionSec === null || lastActionSec === null) return 0;

  const BUFFER_BEFORE = 5;
  const BUFFER_AFTER = 3;

  const trimStartSec = Math.max(0, firstActionSec - BUFFER_BEFORE);
  const trimEndSec = lastActionSec + BUFFER_AFTER;

  // Don't trim very short videos
  if (trimEndSec - trimStartSec < 5) return 0;

  // Check if ffmpeg is available
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' });
  } catch {
    console.log(chalk.dim('Tip: Install ffmpeg to auto-trim dead time from videos.'));
    return 0;
  }

  // Browser-produced VP8 recordings can have long keyframe intervals. A
  // post-input `-ss` with stream copy may therefore emit an empty file. Seek
  // to the nearest preceding keyframe so the trim stays fast and preserves
  // every frame needed to understand the first recorded action.
  const effectiveTrimStartSec = findKeyframeAtOrBefore(videoPath, trimStartSec);

  // Trim the video
  const dir = path.dirname(videoPath);
  const ext = path.extname(videoPath);
  const base = path.basename(videoPath, ext);
  const rawPath = path.join(dir, `${base}-raw-${process.pid}-${Date.now()}${ext}`);

  try {
    // Rename original to -raw
    fs.renameSync(videoPath, rawPath);

    execFileSync('ffmpeg', [
      '-ss', effectiveTrimStartSec.toFixed(2),
      '-to', trimEndSec.toFixed(2),
      '-i', rawPath,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-c', 'copy',
      videoPath,
    ], { stdio: 'pipe', timeout: 60000 });

    const trimmedVideoStatus = validateVideo(videoPath);
    if (!trimmedVideoStatus.available) {
      throw new Error(trimmedVideoStatus.reason);
    }

    // Remove raw file on success
    fs.unlinkSync(rawPath);
    const trimmedDuration = Math.round(trimmedVideoStatus.durationSec ?? (trimEndSec - effectiveTrimStartSec));
    console.log(chalk.dim(`Trimmed video to ${trimmedDuration}s (removed dead time)`));
    return effectiveTrimStartSec;
  } catch (error) {
    // Remove any partial output before restoring the already-validated original.
    try {
      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      if (fs.existsSync(rawPath)) fs.renameSync(rawPath, videoPath);
      console.log(chalk.dim('Video trimming failed, keeping original'));
    } catch (restoreError) {
      console.log(
        chalk.red(
          `Video trimming failed and the original could not be restored: ${restoreError instanceof Error ? restoreError.message : restoreError}`,
        ),
      );
    }
    return 0;
  }
}

function findKeyframeAtOrBefore(videoPath: string, targetSec: number): number {
  if (targetSec <= 0) return 0;

  try {
    const output = execFileSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-skip_frame', 'nokey',
      '-show_entries', 'frame=best_effort_timestamp_time',
      '-of', 'csv=p=0',
      videoPath,
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
    const keyframes = output
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((time) => Number.isFinite(time) && time >= 0 && time <= targetSec);
    return keyframes.length > 0 ? Math.max(...keyframes) : 0;
  } catch {
    return 0;
  }
}
