import chalk from 'chalk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { PROOFSHOT_VERSION } from '../version.js';
import { findConfigPath, loadConfig } from '../utils/config.js';
import { findExecutablePath, readCommandVersion } from '../utils/process.js';
import { loadSession } from '../session/state.js';
import { getCanonicalSkillContent } from '../utils/skills.js';

function statusLabel(ok: boolean, text: string): string {
  return ok ? `${chalk.green('✓')} ${text}` : `${chalk.yellow('⚠')} ${text}`;
}

function printLine(label: string, value: string): void {
  console.log(`${label.padEnd(14)} ${value}`);
}

export async function doctorCommand(options: { json?: boolean } = {}): Promise<void> {
  const configPath = findConfigPath();
  const config = loadConfig();
  const outputDir = config.output;
  const session = loadSession(outputDir);

  const agentBrowserPath = findExecutablePath('agent-browser');
  const ffmpegPath = findExecutablePath('ffmpeg');
  const agentBrowserVersion = readCommandVersion('agent-browser');
  const ffmpegVersion = readCommandVersion('ffmpeg', ['-version']);
  const skills = ['claude', 'codex'].map((agent) => {
    const installedPath = path.join(os.homedir(), `.${agent}`, 'skills', 'proofshot', 'SKILL.md');
    const expectedHash = hash(getCanonicalSkillContent(agent));
    const installedHash = fs.existsSync(installedPath) ? hash(fs.readFileSync(installedPath, 'utf-8')) : null;
    return { agent, installedPath, expectedHash, installedHash, status: installedHash === null ? 'missing' : installedHash === expectedHash ? 'current' : 'divergent' };
  });

  if (options.json) {
    console.log(JSON.stringify({
      proofshotVersion: PROOFSHOT_VERSION,
      configPath,
      outputDir,
      browserMode: config.headless ? 'headless' : 'headed',
      viewport: config.viewport,
      agentBrowser: { path: agentBrowserPath, version: agentBrowserVersion },
      ffmpeg: { path: ffmpegPath, version: ffmpegVersion },
      session,
      skills,
    }, null, 2));
    return;
  }

  console.log(chalk.bold('ProofShot Doctor'));
  console.log('');

  printLine('ProofShot', PROOFSHOT_VERSION);
  printLine('Config', configPath || chalk.dim('not found'));
  printLine('Output', outputDir);
  printLine('Browser mode', config.headless ? 'headless' : 'headed');
  printLine('Viewport', `${config.viewport.width}x${config.viewport.height}`);
  console.log('');

  console.log(statusLabel(Boolean(agentBrowserPath), 'agent-browser'));
  printLine('Path', agentBrowserPath || chalk.dim('not found'));
  printLine('Version', agentBrowserVersion || chalk.dim('not available'));
  console.log('');

  console.log(statusLabel(Boolean(ffmpegPath), 'ffmpeg'));
  printLine('Path', ffmpegPath || chalk.dim('not found'));
  printLine('Version', ffmpegVersion || chalk.dim('not available'));
  console.log('');

  console.log(session ? statusLabel(true, 'active session') : `${chalk.green('✓')} no active session`);
  if (session) {
    printLine('Session dir', session.sessionDir);
    printLine('Recording', session.recordingActive ? 'active' : 'stopped');
    printLine('Port', String(session.port));
  } else {
    printLine('Session dir', chalk.dim('none'));
  }
  console.log('');
  for (const skill of skills) {
    console.log(statusLabel(skill.status === 'current', `${skill.agent} skill: ${skill.status}`));
    printLine('Path', skill.installedPath);
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
