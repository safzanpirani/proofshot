import * as path from 'path';
import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { loadConfig } from '../utils/config.js';
import { ab, abArgs, setAgentBrowserDefaults } from '../utils/exec.js';
import { ensureDevServer } from '../server/start.js';
import { closeBrowser, openBrowser } from '../browser/session.js';
import { startRecording, stopRecording } from '../browser/capture.js';
import { ensureOutputDir, generateTimestamp, generateSessionDirName } from '../artifacts/bundle.js';
import {
  saveSession,
  hasActiveSession,
  clearSession,
  acquireSessionStartLock,
  generateAgentBrowserSessionName,
  releaseSessionStartLock,
  type SessionStartLock,
  writeSessionPointer,
  loadSession,
} from '../session/state.js';
import { writeMetadata } from '../session/metadata.js';
import { getProcessIdentity, processIdentityMatches, terminateOwnedProcessTree } from '../utils/process.js';
import { PROOFSHOT_COMMIT } from '../version.js';

interface StartOptions {
  description?: string;
  port?: number;
  run?: string;
  headed?: boolean;
  output?: string;
  url?: string;
  force?: boolean;
  takePort?: boolean;
  scenarioManifest?: string;
}

export function parseChangedFiles(status: string): string[] {
  const output = status.trimEnd();
  return output ? output.split('\n').map((line) => line.slice(3).trim()).filter(Boolean) : [];
}

export function hashWorkingTreeDiff(trackedDiff: Buffer, untrackedFiles: string[], cwd = process.cwd()): string {
  const hash = createHash('sha256').update(trackedDiff);
  for (const file of [...untrackedFiles].sort()) {
    const filePath = path.resolve(cwd, file);
    const stat = fs.lstatSync(filePath);
    hash.update('\0untracked\0').update(file).update('\0');
    if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(filePath));
    else if (stat.isFile()) hash.update(fs.readFileSync(filePath));
  }
  return hash.digest('hex');
}

export async function startCommand(options: StartOptions): Promise<boolean> {
  const config = loadConfig();
  const defaultOutputDir = path.resolve(config.output);
  setAgentBrowserDefaults({ configPath: config.browser.configPath });
  if (options.port) config.devServer.port = options.port;
  if (options.output) config.output = options.output;
  if (options.headed !== undefined) config.headless = !options.headed;

  const outputDir = path.resolve(config.output);
  const timestamp = generateTimestamp();
  const sessionRoots = [...new Set([defaultOutputDir, outputDir])];
  let startLock: SessionStartLock;
  try {
    startLock = acquireSessionStartLock(defaultOutputDir);
  } catch (error) {
    console.error(chalk.red('✗') + ` Could not start a session: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    return false;
  }
  let startLockReleased = false;
  const releaseStartLock = (): void => {
    if (startLockReleased) return;
    releaseSessionStartLock(startLock);
    startLockReleased = true;
  };
  const activeSessionRoots = sessionRoots.filter((root) => hasActiveSession(root));

  if (activeSessionRoots.length > 0) {
    if (options.force) {
      const existingSessions = activeSessionRoots
        .map((root) => loadSession(root))
        .filter((session, index, sessions) => session !== null && sessions.findIndex((candidate) => candidate?.outputDir === session.outputDir && candidate.sessionName === session.sessionName) === index);
      for (const existing of existingSessions) {
        if (!existing) continue;
        let browserAlive = false;
        try { ab('get url', { session: existing.sessionName, timeoutMs: 5000 }); browserAlive = true; } catch { /* stale browser */ }
        const serverAlive = existing.serverProcess
          ? processIdentityMatches(getProcessIdentity(existing.serverProcess.pid), existing.serverProcess)
          : false;
        if (browserAlive || serverAlive) {
          releaseStartLock();
          console.error(chalk.red('✗') + ' Refusing --force because lifecycle checks still find owned session resources. Run "proofshot stop" first.');
          process.exit(1);
        }
      }
      for (const root of activeSessionRoots) clearSession(root);
      console.log(chalk.yellow('⚠') + chalk.dim(' Cleared a session after proving its browser and owned server were stale'));
    } else {
      console.log(
        chalk.yellow('⚠ A session is already active.') +
          chalk.dim(' Run "proofshot stop" first, or use --force to override.'),
      );
      releaseStartLock();
      process.exitCode = 1;
      return false;
    }
  }

  ensureOutputDir(outputDir);

  const sessionDirName = generateSessionDirName(timestamp, options.description || null);
  const sessionDir = path.join(outputDir, sessionDirName);
  const sessionName = generateAgentBrowserSessionName(timestamp);
  ensureOutputDir(sessionDir);

  const videoPath = path.join(sessionDir, 'session.webm');
  const serverErrorLog = path.join(sessionDir, 'server.log');

  let branch = '';
  let commitSha = '';
  let dirty = false;
  let changedFiles: string[] = [];
  let diffHash: string | null = null;
  try {
    branch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // Non-fatal outside a git repo.
  }
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
    dirty = Boolean(status);
    changedFiles = parseChangedFiles(status);
    if (dirty) {
      const diff = execSync('git diff HEAD --binary', { encoding: 'buffer', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024 });
      const untrackedOutput = execSync('git ls-files --others --exclude-standard -z', {
        encoding: 'buffer',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024,
      });
      const untrackedFiles = untrackedOutput.toString('utf-8').split('\0').filter(Boolean).sort();
      diffHash = hashWorkingTreeDiff(diff, untrackedFiles);
    }
  } catch { /* git provenance remains unavailable */ }
  try {
    commitSha = execSync('git rev-parse HEAD', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // Non-fatal outside a git repo.
  }

  writeMetadata(sessionDir, {
    branch,
    commitSha,
    startedAt: new Date().toISOString(),
    description: options.description || null,
    dirty,
    changedFiles,
    diffHash,
    proofshotBuildSha: PROOFSHOT_COMMIT,
    scenarioManifest: options.scenarioManifest || null,
  });

  let serverAlreadyRunning = true;
  let serverPumpPid: number | null = null;
  let serverProcess: Awaited<ReturnType<typeof ensureDevServer>>['processIdentity'] = null;
  let browserOpened = false;
  let recordingStarted = false;
  const ownershipToken = randomUUID();

  const rollback = async (): Promise<void> => {
    if (recordingStarted) {
      try { stopRecording(sessionName); } catch { /* continue releasing other resources */ }
    }
    if (browserOpened) {
      try { closeBrowser(sessionName); } catch { /* continue releasing other resources */ }
    }
    if (serverProcess) {
      try { await terminateOwnedProcessTree(serverProcess); } catch (error) {
        console.error(chalk.red('✗') + ` Startup rollback could not stop the server: ${error instanceof Error ? error.message : error}`);
      }
    }
    for (const root of sessionRoots) {
      try { clearSession(root); } catch { /* continue releasing other state */ }
    }
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch { /* retain partial diagnostics if removal fails */ }
    try { releaseStartLock(); } catch { /* process exit will leave a recoverable stale claim */ }
  };

  if (options.run) {
    console.log(chalk.dim(`Starting: ${options.run}`));
    try {
      const serverResult = await ensureDevServer(
        options.run,
        config.devServer.port,
        config.devServer.startupTimeout,
        serverErrorLog,
        { takePort: options.takePort, ownershipToken },
      );
      serverPumpPid = serverResult.pumpPid;
      serverProcess = serverResult.processIdentity;
      serverAlreadyRunning = false;
      console.log(chalk.green('✓') + ` Dev server started on :${config.devServer.port}`);
      console.log(chalk.dim(`  Server logs → ${serverErrorLog}`));
    } catch (error: any) {
      await rollback();
      console.error(chalk.red('✗') + ` Failed to start dev server: ${error.message}`);
      process.exit(1);
    }
  } else {
    console.log(chalk.dim('No --run provided, assuming server is already running'));
  }

  const baseUrl = `http://localhost:${config.devServer.port}`;
  const openUrl = options.url || baseUrl;

  console.log(chalk.dim('Opening browser...'));
  try {
    browserOpened = true;
    openBrowser(openUrl, config.viewport, config.headless, sessionName, config.browser);
    console.log(chalk.green('✓') + ' Browser ready');
  } catch (error: any) {
    await rollback();
    console.error(
      chalk.red('✗') +
        ` Failed to open browser: ${error.message}\n` +
        chalk.dim('Make sure agent-browser is installed: npm install -g agent-browser'),
    );
    process.exit(1);
  }

  const RECORDING_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;
  let lastError: any;

  for (let attempt = 1; attempt <= RECORDING_RETRIES; attempt++) {
    try {
      startRecording(videoPath, sessionName);
      recordingStarted = true;
      console.log(chalk.green('✓') + ' Recording started');
      break;
    } catch (error: any) {
      lastError = error;
      if (attempt < RECORDING_RETRIES) {
        console.log(
          chalk.yellow('⚠') +
            ` Recording failed (attempt ${attempt}/${RECORDING_RETRIES}), retrying in ${RETRY_DELAY_MS / 1000}s...`,
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  if (!recordingStarted) {
    await rollback();
    console.error(
      chalk.red('✗') +
        ` Failed to initialize recording after ${RECORDING_RETRIES} attempts: ${lastError?.message}\n` +
        chalk.dim('Recording is required — ProofShot cannot proceed without video capture.\n') +
        chalk.dim('Troubleshooting:\n') +
        chalk.dim('  1. Make sure agent-browser is installed and running\n') +
        chalk.dim('  2. Try "proofshot clean" then re-run "proofshot start"\n') +
        chalk.dim('  3. If the port was already in use, stop the old server first'),
    );
    process.exit(1);
  }

  try {
    saveSession({
      schemaVersion: 2,
      ownershipToken,
      startedAt: new Date().toISOString(),
      description: options.description || null,
      outputDir,
      sessionDir,
      sessionName,
      videoPath,
      serverErrorLog,
      port: config.devServer.port,
      serverCommand: options.run || null,
      serverAlreadyRunning,
      serverPumpPid,
      serverProcess,
      recordingActive: true,
      viewport: { width: config.viewport.width, height: config.viewport.height },
      initialViewport: { width: config.viewport.width, height: config.viewport.height },
      viewportChanges: [],
      headless: config.headless,
      deviceScaleFactor: readBrowserNumber('window.devicePixelRatio', sessionName) ?? 1,
      browserVersion: readBrowserString('navigator.userAgent', sessionName),
      agentBrowserVersion: readAgentBrowserVersion(),
      proofshotCommit: PROOFSHOT_COMMIT,
    });

    // `exec`/`stop` look in the configured output dir. If --output moved this
    // session elsewhere, leave a breadcrumb there so they can still find it.
    if (options.output) {
      writeSessionPointer(defaultOutputDir, outputDir);
    }
  } catch (error) {
    await rollback();
    console.error(chalk.red('✗') + ` Failed to save session state: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  console.log('');
  console.log(chalk.green.bold('✅ ProofShot session started'));
  console.log('');
  console.log(`Server:     ${options.run ? chalk.cyan(options.run) : chalk.dim('external')} on :${config.devServer.port}`);
  console.log(`Browser:    Chromium (${config.headless ? 'headless' : 'headed'})`);
  console.log(`Session:    ${chalk.dim(sessionName)}`);
  console.log(`Recording:  ${chalk.dim(videoPath)}`);
  console.log(`Errors log: ${chalk.dim(serverErrorLog)}`);

  if (options.description) {
    console.log(`Verifying:  ${chalk.white(options.description)}`);
  }

  console.log('');
  console.log(chalk.dim('Use proofshot exec to navigate and test:'));
  console.log(chalk.dim('  proofshot exec snapshot -i            # See interactive elements'));
  console.log(chalk.dim('  proofshot exec click @e3              # Click an element'));
  console.log(chalk.dim('  proofshot exec fill @e2 "text"        # Fill a form field'));
  console.log(chalk.dim('  proofshot exec screenshot step.png    # Capture a moment'));
  console.log('');
  console.log(`When done, run: ${chalk.white('proofshot stop')}`);
  releaseStartLock();
  return true;
}

function parseBrowserValue(raw: string): unknown {
  let value: unknown = raw;
  for (let index = 0; index < 2 && typeof value === 'string'; index++) {
    try { value = JSON.parse(value); } catch { break; }
  }
  return value;
}

function readBrowserString(expression: string, sessionName: string): string | null {
  try {
    const value = parseBrowserValue(abArgs(['eval', expression], { session: sessionName }));
    return typeof value === 'string' ? value : null;
  } catch { return null; }
}

function readBrowserNumber(expression: string, sessionName: string): number | null {
  try {
    const value = parseBrowserValue(abArgs(['eval', expression], { session: sessionName }));
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch { return null; }
}

function readAgentBrowserVersion(): string | null {
  try { return ab('--version', 5000); } catch { return null; }
}
