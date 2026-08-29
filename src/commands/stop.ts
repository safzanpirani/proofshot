import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';
import chalk from 'chalk';
import { loadConfig } from '../utils/config.js';
import { setAgentBrowserDefaults } from '../utils/exec.js';
import { closeBrowser, getConsoleErrors, getConsoleOutput, getConsoleOutputJson } from '../browser/session.js';
import { stopRecording } from '../browser/capture.js';
import { loadSession, clearSession, saveSession } from '../session/state.js';
import { terminateOwnedProcessTree } from '../utils/process.js';
import { writeViewer, type TimestampedLogEntry } from '../artifacts/viewer.js';
import { extractServerErrors } from '../utils/error-patterns.js';
import { loadSessionLog } from './exec.js';
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
  const sessionLog = loadSessionLog(sessionDir);
  let trimOffsetSec = 0;
  let videoStatus = validateVideo(session.videoPath);
  if (videoStatus.available) {
    trimOffsetSec = trimVideo(session.videoPath, screenshots, sessionDir, startTime, sessionLog);
    videoStatus = validateVideo(session.videoPath);
    if (!videoStatus.available) incompleteReasons.push(videoStatus.reason);
  } else if (session.recordingActive) {
    incompleteReasons.push(videoStatus.reason);
    console.log(
      chalk.yellow('⚠') +
        ' Recording was active but no video file was produced.\n' +
        chalk.dim('  The screencast may have been interrupted. Screenshots and logs are still saved.'),
    );
  }

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
  writeJsonAtomic(path.join(sessionDir, 'manifest.json'), {
    schemaVersion: 1,
    session: path.basename(sessionDir),
    screenshots,
    assertionsFile: fs.existsSync(resultPath) ? 'result.json' : null,
    metadataFile: 'metadata.json',
  });

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
    durationSec,
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
    durationSec,
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
    assertions: recordedAssertions,
    assertionsPassed: assertionFailures === 0,
    evidenceComplete: incompleteReasons.length === 0,
    console: { status: consoleStatus, errorCount: consoleErrorCount },
    server: { status: serverStatus, errorCount: serverErrorCount },
    video: { status: videoStatus.available ? 'captured' : 'unavailable', reason: videoStatus.reason || null },
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
    console.log(`📹 Video:         ${chalk.dim(session.videoPath)} (${durationSec}s)`);
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
  console.log(`Duration:         ${durationSec} seconds`);
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

function generateProofSummary(data: SummaryData): string {
  const date = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const projectName = path.basename(process.cwd());

  let md = `# ProofShot Verification Report

**Date:** ${date}
**Project:** ${projectName}
**Dev Server:** ${data.serverCommand ? data.serverCommand : 'external'} on localhost:${data.port}

`;

  if (data.description) {
    md += `## What Was Verified

${data.description}

`;
  }

  // Video
  const relativeVideo = path.basename(data.videoPath);
  md += `## Video Recording\n\n${data.videoStatus === 'captured' ? `Full session recording: [${relativeVideo}](./${relativeVideo}) (${data.durationSec}s)` : 'Video capture unavailable.'}\n\n`;

  // Screenshots
  if (data.screenshots.length > 0) {
    md += `## Screenshots

`;
    for (const ss of data.screenshots) {
      md += `![${ss}](./${ss})\n\n`;
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
    md += `${data.consoleErrorCount} error(s) detected:\n\n\`\`\`\n${data.consoleErrors}\n\`\`\`\n\n`;
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
    md += `${data.serverErrorCount} error(s) detected:\n\n\`\`\`\n${data.serverLog.slice(0, 5000)}\n\`\`\`\n\n`;
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
    md += `## Unavailable Evidence\n\n${data.incompleteReasons.map((reason) => `- ${reason}`).join('\n')}\n\n`;
  }

  md += `## Environment
- Browser mode: ${data.environment.headless ? 'headless' : 'headed'}
- Browser: ${data.environment.browserVersion || 'unavailable'}
- agent-browser: ${data.environment.agentBrowserVersion || 'unavailable'}
- Initial viewport: ${data.environment.initialViewport.width}x${data.environment.initialViewport.height}
- Final viewport: ${data.environment.viewport?.width || 'unavailable'}x${data.environment.viewport?.height || 'unavailable'}
- Device scale factor: ${data.environment.deviceScaleFactor}
- ProofShot commit: ${data.environment.proofshotCommit || 'unavailable'}
- Duration: ${data.durationSec} seconds
`;

  return md;
}

function validateVideo(videoPath: string): { available: boolean; reason: string } {
  if (!fs.existsSync(videoPath)) return { available: false, reason: 'Video file was not produced' };
  const size = fs.statSync(videoPath).size;
  if (size === 0) return { available: false, reason: 'Video file is empty' };
  try {
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', videoPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
    return { available: true, reason: '' };
  } catch (error) {
    return { available: false, reason: `Video integrity check failed: ${error instanceof Error ? error.message : error}` };
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
function trimVideo(
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
    firstActionSec = sessionLog[0].relativeTimeSec;
    lastActionSec = sessionLog[sessionLog.length - 1].relativeTimeSec;
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
    execSync('ffmpeg -version', { stdio: 'pipe' });
  } catch {
    console.log(chalk.dim('Tip: Install ffmpeg to auto-trim dead time from videos.'));
    return 0;
  }

  // Trim the video
  const dir = path.dirname(videoPath);
  const ext = path.extname(videoPath);
  const base = path.basename(videoPath, ext);
  const rawPath = path.join(dir, `${base}-raw${ext}`);

  try {
    // Rename original to -raw
    fs.renameSync(videoPath, rawPath);

    execSync(
      `ffmpeg -i "${rawPath}" -ss ${trimStartSec.toFixed(2)} -to ${trimEndSec.toFixed(2)} -c copy "${videoPath}"`,
      { stdio: 'pipe', timeout: 60000 },
    );

    // Remove raw file on success
    fs.unlinkSync(rawPath);
    const trimmedDuration = Math.round(trimEndSec - trimStartSec);
    console.log(chalk.dim(`Trimmed video to ${trimmedDuration}s (removed dead time)`));
    return trimStartSec;
  } catch {
    // Restore original if trimming failed
    if (fs.existsSync(rawPath)) {
      if (!fs.existsSync(videoPath)) {
        fs.renameSync(rawPath, videoPath);
      } else {
        fs.unlinkSync(rawPath);
      }
    }
    console.log(chalk.dim('Video trimming failed, keeping original'));
    return 0;
  }
}
