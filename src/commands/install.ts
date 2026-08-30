import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { readBundledSkill, getInlineSkillContent } from '../utils/skills.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToolName =
  | 'claude'
  | 'cursor'
  | 'codex'
  | 'gemini'
  | 'windsurf'
  | 'opencode';

type SkillTarget =
  | { strategy: 'file'; relativePath: string }
  | { strategy: 'append'; relativePath: string };

interface ToolDefinition {
  name: ToolName;
  displayName: string;
  binaryName: string;
  configDir: string;
  skillTarget: SkillTarget;
  /** Path inside the bundled skills/ directory */
  bundledSkill: string;
}

interface InstallResult {
  tool: ToolName;
  displayName: string;
  status: 'installed' | 'updated' | 'skipped' | 'failed';
  path: string;
  message?: string;
}

export interface InstallOptions {
  only?: string;
  skip?: string;
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MARKER_START = '<!-- proofshot:start -->';
const MARKER_END = '<!-- proofshot:end -->';
const TOOL_NAMES: ToolName[] = ['claude', 'cursor', 'codex', 'gemini', 'windsurf', 'opencode'];

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

function getToolDefinitions(): ToolDefinition[] {
  const home = os.homedir();
  return [
    {
      name: 'claude',
      displayName: 'Claude Code',
      binaryName: 'claude',
      configDir: path.join(home, '.claude'),
      skillTarget: { strategy: 'file', relativePath: 'skills/proofshot/SKILL.md' },
      bundledSkill: 'claude/SKILL.md',
    },
    {
      name: 'cursor',
      displayName: 'Cursor',
      binaryName: 'cursor',
      configDir: path.join(home, '.cursor'),
      skillTarget: { strategy: 'file', relativePath: 'rules/proofshot.mdc' },
      bundledSkill: 'cursor/proofshot.mdc',
    },
    {
      name: 'codex',
      displayName: 'Codex (OpenAI)',
      binaryName: 'codex',
      configDir: path.join(home, '.codex'),
      skillTarget: { strategy: 'file', relativePath: 'skills/proofshot/SKILL.md' },
      bundledSkill: 'codex/SKILL.md',
    },
    {
      name: 'gemini',
      displayName: 'Gemini CLI',
      binaryName: 'gemini',
      configDir: path.join(home, '.gemini'),
      skillTarget: { strategy: 'append', relativePath: 'GEMINI.md' },
      bundledSkill: 'generic/PROOFSHOT.md',
    },
    {
      name: 'windsurf',
      displayName: 'Windsurf',
      binaryName: 'windsurf',
      configDir: path.join(home, '.codeium', 'windsurf'),
      skillTarget: { strategy: 'append', relativePath: 'memories/global_rules.md' },
      bundledSkill: 'generic/PROOFSHOT.md',
    },
    {
      name: 'opencode',
      displayName: 'OpenCode',
      binaryName: 'opencode',
      configDir: path.join(home, '.config', 'opencode'),
      skillTarget: { strategy: 'file', relativePath: 'skills/proofshot/SKILL.md' },
      bundledSkill: 'opencode/SKILL.md',
    },
  ];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function isBinaryAvailable(binaryName: string): boolean {
  const cmd = process.platform === 'win32' ? `where ${binaryName}` : `which ${binaryName}`;
  try {
    execSync(cmd, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function detectInstalledTools(): ToolDefinition[] {
  return getToolDefinitions().filter(
    (tool) => isBinaryAvailable(tool.binaryName) || fs.existsSync(tool.configDir),
  );
}

export function parseToolFilter(value: string, option: '--only' | '--skip'): Set<ToolName> {
  const names = value.split(',').map((name) => name.trim().toLowerCase());
  const invalid = names.filter((name) => !TOOL_NAMES.includes(name as ToolName));
  if (invalid.length > 0) {
    const rendered = invalid.map((name) => name || '<empty>').join(', ');
    throw new Error(`Invalid ${option} tool name(s): ${rendered}. Expected: ${TOOL_NAMES.join(', ')}`);
  }
  return new Set(names as ToolName[]);
}

function filterTools(
  detected: ToolDefinition[],
  only?: string,
  skip?: string,
): ToolDefinition[] {
  let tools = detected;
  if (only) {
    const onlySet = parseToolFilter(only, '--only');
    tools = tools.filter((t) => onlySet.has(t.name));
  }
  if (skip) {
    const skipSet = parseToolFilter(skip, '--skip');
    tools = tools.filter((t) => !skipSet.has(t.name));
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Content resolution
// ---------------------------------------------------------------------------

function getSkillContent(tool: ToolDefinition): string {
  const fallbackAgent = tool.name === 'gemini' || tool.name === 'windsurf'
    ? 'generic'
    : tool.name;
  return readBundledSkill(tool.bundledSkill) ?? getInlineSkillContent(fallbackAgent);
}

// ---------------------------------------------------------------------------
// Installation strategies
// ---------------------------------------------------------------------------

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getAppendMarkerStatus(existing: string): 'absent' | 'valid' | 'malformed' {
  const startCount = existing.split(MARKER_START).length - 1;
  const endCount = existing.split(MARKER_END).length - 1;
  if (startCount === 0 && endCount === 0) return 'absent';
  if (
    startCount === 1
    && endCount === 1
    && existing.indexOf(MARKER_START) < existing.indexOf(MARKER_END)
  ) return 'valid';
  return 'malformed';
}

function installFile(
  tool: ToolDefinition,
  targetPath: string,
  content: string,
  force: boolean,
): InstallResult {
  const exists = fs.existsSync(targetPath);
  if (exists && !force) {
    const existing = fs.readFileSync(targetPath, 'utf-8');
    if (existing === content) {
      return {
        tool: tool.name,
        displayName: tool.displayName,
        status: 'skipped',
        path: targetPath,
        message: 'Already up to date',
      };
    }
    return {
      tool: tool.name,
      displayName: tool.displayName,
      status: 'failed',
      path: targetPath,
      message: 'Installed skill differs from the bundled workflow; use --force to replace it',
    };
  }

  fs.writeFileSync(targetPath, content);
  return {
    tool: tool.name,
    displayName: tool.displayName,
    status: exists ? 'updated' : 'installed',
    path: targetPath,
  };
}

function installAppend(
  tool: ToolDefinition,
  targetPath: string,
  content: string,
  force: boolean,
): InstallResult {
  const markedContent = `${MARKER_START}\n${content}\n${MARKER_END}`;
  const exists = fs.existsSync(targetPath);

  if (exists) {
    const existing = fs.readFileSync(targetPath, 'utf-8');
    const markerStatus = getAppendMarkerStatus(existing);

    if (markerStatus === 'malformed') {
      return {
        tool: tool.name,
        displayName: tool.displayName,
        status: 'failed',
        path: targetPath,
        message: 'ProofShot markers are malformed; repair the existing marker block before reinstalling',
      };
    }

    if (markerStatus === 'valid') {
      // Replace existing marked block
      const regex = new RegExp(
        `${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}`,
      );
      const updated = existing.replace(regex, markedContent);

      if (updated !== existing && !force) {
        return {
          tool: tool.name,
          displayName: tool.displayName,
          status: 'failed',
          path: targetPath,
          message: 'Installed rules differ from the bundled workflow; use --force to replace them',
        };
      }

      if (updated === existing && !force) {
        return {
          tool: tool.name,
          displayName: tool.displayName,
          status: 'skipped',
          path: targetPath,
          message: 'Already up to date',
        };
      }

      fs.writeFileSync(targetPath, updated);
      return {
        tool: tool.name,
        displayName: tool.displayName,
        status: 'updated',
        path: targetPath,
      };
    }

    // No markers found — append
    fs.appendFileSync(targetPath, '\n\n' + markedContent + '\n');
    return {
      tool: tool.name,
      displayName: tool.displayName,
      status: 'installed',
      path: targetPath,
    };
  }

  // File does not exist — create
  fs.writeFileSync(targetPath, markedContent + '\n');
  return {
    tool: tool.name,
    displayName: tool.displayName,
    status: 'installed',
    path: targetPath,
  };
}

function installForTool(tool: ToolDefinition, force: boolean): InstallResult {
  const content = getSkillContent(tool);
  const targetPath = path.join(tool.configDir, tool.skillTarget.relativePath);
  const targetDir = path.dirname(targetPath);

  try {
    fs.mkdirSync(targetDir, { recursive: true });

    if (tool.skillTarget.strategy === 'file') {
      return installFile(tool, targetPath, content, force);
    } else {
      return installAppend(tool, targetPath, content, force);
    }
  } catch (error: any) {
    return {
      tool: tool.name,
      displayName: tool.displayName,
      status: 'failed',
      path: targetPath,
      message: error.message,
    };
  }
}

// ---------------------------------------------------------------------------
// Interactive prompt
// ---------------------------------------------------------------------------

function checkboxSelect(tools: ToolDefinition[]): Promise<ToolDefinition[]> {
  return new Promise((resolve) => {
    const selected = new Array(tools.length).fill(true);
    let cursor = 0;

    function render() {
      // Move cursor up to overwrite previous render (except first)
      if (renderCount > 0) {
        process.stdout.write(`\x1b[${tools.length + 2}A`);
      }
      renderCount++;

      console.log(chalk.bold('Select tools to install:'));
      console.log('');
      for (let i = 0; i < tools.length; i++) {
        const check = selected[i] ? chalk.green('[x]') : chalk.dim('[ ]');
        const label = tools[i].displayName;
        const pointer = i === cursor ? chalk.green('> ') : '  ';
        console.log(`${pointer}${check} ${label}`);
      }
    }

    let renderCount = 0;
    render();
    console.log('');
    process.stdout.write(chalk.dim('  ↑/↓ navigate · space toggle · enter confirm'));

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf-8');

    function onData(key: string) {
      // Ctrl+C
      if (key === '\x03') {
        stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        stdin.pause();
        // Clear the hint line and move down
        process.stdout.write('\r\x1b[K\n');
        resolve([]);
        return;
      }

      // Enter
      if (key === '\r' || key === '\n') {
        stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        stdin.pause();
        // Clear the hint line and move down
        process.stdout.write('\r\x1b[K\n');
        resolve(tools.filter((_, i) => selected[i]));
        return;
      }

      // Space — toggle
      if (key === ' ') {
        selected[cursor] = !selected[cursor];
        // Move up to re-render hint, then re-render
        process.stdout.write('\r\x1b[K');
        process.stdout.write(`\x1b[1A`);
        render();
        console.log('');
        process.stdout.write(chalk.dim('  ↑/↓ navigate · space toggle · enter confirm'));
        return;
      }

      // Arrow up
      if (key === '\x1b[A') {
        cursor = (cursor - 1 + tools.length) % tools.length;
        process.stdout.write('\r\x1b[K');
        process.stdout.write(`\x1b[1A`);
        render();
        console.log('');
        process.stdout.write(chalk.dim('  ↑/↓ navigate · space toggle · enter confirm'));
        return;
      }

      // Arrow down
      if (key === '\x1b[B') {
        cursor = (cursor + 1) % tools.length;
        process.stdout.write('\r\x1b[K');
        process.stdout.write(`\x1b[1A`);
        render();
        console.log('');
        process.stdout.write(chalk.dim('  ↑/↓ navigate · space toggle · enter confirm'));
        return;
      }
    }

    stdin.on('data', onData);
  });
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function installCommand(options: InstallOptions): Promise<void> {
  const allDetected = detectInstalledTools();
  let tools: ToolDefinition[];
  try {
    tools = filterTools(allDetected, options.only, options.skip);
  } catch (error) {
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
    process.exitCode = 1;
    return;
  }

  if (tools.length === 0) {
    if (options.only || options.skip) {
      console.log(chalk.yellow('No matching AI tools found after applying filters.'));
      console.log(
        chalk.dim(
          'Detected tools: ' + (allDetected.map((t) => t.name).join(', ') || 'none'),
        ),
      );
    } else {
      console.log(chalk.yellow('No AI coding tools detected on this machine.'));
      console.log(chalk.dim('Looked for: claude, cursor, codex, gemini, windsurf, opencode'));
    }
    return;
  }

  // Interactive selection (or install all if non-interactive)
  let selectedTools = tools;
  if (process.stdin.isTTY) {
    console.log('');
    const picked = await checkboxSelect(tools);
    if (picked.length === 0) {
      console.log(chalk.dim('Aborted.'));
      return;
    }
    selectedTools = picked;
  } else {
    console.log('');
    console.log(chalk.bold('Detected AI coding tools:'));
    console.log('');
    for (const tool of tools) {
      console.log(`  ${chalk.green('\u25cf')} ${tool.displayName}`);
    }
    console.log('');
  }

  // Install for each tool
  const results: InstallResult[] = [];
  for (const tool of selectedTools) {
    const result = installForTool(tool, !!options.force);
    results.push(result);

    const icon =
      result.status === 'failed'
        ? chalk.red('\u2717')
        : result.status === 'skipped'
          ? chalk.dim('\u2013')
          : chalk.green('\u2713');
    const statusText =
      result.status === 'installed'
        ? 'Installed'
        : result.status === 'updated'
          ? 'Updated'
          : result.status === 'skipped'
            ? 'Skipped'
            : 'Failed';
    const suffix = result.message ? chalk.dim(` (${result.message})`) : '';

    console.log(`${icon} ${tool.displayName}: ${statusText}${suffix}`);
    if (result.status !== 'failed') {
      console.log(chalk.dim(`  \u2192 ${result.path}`));
    } else if (result.message) {
      console.log(chalk.red(`  ${result.message}`));
    }
  }

  // Summary
  const installed = results.filter(
    (r) => r.status === 'installed' || r.status === 'updated',
  ).length;
  const failed = results.filter((r) => r.status === 'failed').length;
  console.log('');

  if (failed > 0) {
    console.log(chalk.yellow(`Done. ${installed} installed, ${failed} failed.`));
    process.exitCode = 1;
  } else if (installed > 0) {
    console.log(chalk.green(`Done! ProofShot skills installed for ${installed} tool(s).`));
    console.log('');
    console.log(`You're all set! In any project, tell your AI agent:`);
    console.log('');
    console.log(chalk.white(`  "Verify the changes visually with proofshot"`));
    console.log('');
  } else {
    console.log(chalk.dim('All tools already up to date.'));
  }
}
