import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { loadConfig } from '../utils/config.js';
import { ab, buildAgentBrowserCommand, setAgentBrowserDefaults } from '../utils/exec.js';
import { loadSession, saveSession, type SessionState } from '../session/state.js';
import { writeJsonAtomic } from '../utils/atomic.js';

const SESSION_LOG_FILENAME = 'session-log.jsonl';
const RESULT_FILENAME = 'result.json';

export interface SessionLogEntry {
  action: string;
  relativeTimeSec: number;
  timestamp: string;
  startedAt: string;
  finishedAt: string;
  exitStatus: number;
  success: boolean;
  stderr?: string;
  resultingUrl?: string;
  screenshot?: { path: string; width: number; height: number };
  assertion?: { type: string; expected?: string; passed: boolean; message: string };
  element?: {
    label: string;
    bbox: { x: number; y: number; width: number; height: number };
    viewport: { width: number; height: number };
  };
}

/**
 * Load existing session log entries from disk.
 */
export function loadSessionLog(sessionDir: string): SessionLogEntry[] {
  const logPath = path.join(sessionDir, SESSION_LOG_FILENAME);
  if (!fs.existsSync(logPath)) return [];
  try {
    return fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * For screenshot commands, resolve relative paths into the session directory
 * so agents can just say `proofshot exec screenshot step-name.png`.
 */
function resolveScreenshotPath(args: string[], sessionDir: string): string[] {
  if (args[0] !== 'screenshot' || args.length < 2) return args;

  const viewportOnly = args.includes('--viewport-only');
  const normalized = args.filter((arg) => arg !== '--viewport-only');
  const screenshotPath = [...normalized].reverse().find((arg) => !arg.startsWith('-'))!;
  // If it's already absolute, leave it alone
  const withMode = viewportOnly || normalized.includes('--full') ? normalized : [...normalized, '--full'];
  if (path.isAbsolute(screenshotPath)) return withMode;

  // Resolve relative to session dir
  const resolved = path.join(sessionDir, screenshotPath);
  return withMode.map((arg) => arg === screenshotPath ? resolved : arg);
}

function parseBrowserValue(raw: string): unknown {
  let value: unknown = raw;
  for (let index = 0; index < 2 && typeof value === 'string'; index++) {
    try { value = JSON.parse(value); } catch { break; }
  }
  return value;
}

function readPageUrl(sessionName: string): string {
  const value = parseBrowserValue(ab(`eval ${JSON.stringify('window.location.href')}`, { session: sessionName }));
  if (typeof value !== 'string') throw new Error('agent-browser returned an invalid page URL');
  return value;
}

function redactStderr(stderr: string): string {
  return stderr
    .replace(/(token|password|secret|authorization|cookie)(\s*[:=]\s*)\S+/gi, '$1$2[REDACTED]')
    .slice(0, 4000);
}

function pngDimensions(filePath: string): { width: number; height: number } | undefined {
  try {
    const bytes = fs.readFileSync(filePath);
    if (bytes.length < 24 || bytes.toString('ascii', 1, 4) !== 'PNG') return undefined;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } catch { return undefined; }
}

function appendLog(sessionDir: string, entry: SessionLogEntry): void {
  fs.appendFileSync(path.join(sessionDir, SESSION_LOG_FILENAME), JSON.stringify(entry) + '\n', { mode: 0o600 });
}

function runAssertion(args: string[], session: SessionState): NonNullable<SessionLogEntry['assertion']> {
  const type = args[1];
  const expected = args.slice(2).join(' ');
  let passed = false;
  let message = '';
  if (type === 'visible' || type === 'absent') {
    if (!expected) throw new Error(`assert ${type} requires text`);
    const script = `(() => { const wanted=${JSON.stringify(expected)}; return [...document.querySelectorAll('body *')].some(e => e.textContent?.includes(wanted) && !!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)); })()`;
    const visible = Boolean(parseBrowserValue(ab(`eval ${JSON.stringify(script)}`, { session: session.sessionName })));
    passed = type === 'visible' ? visible : !visible;
    message = `${JSON.stringify(expected)} was ${visible ? 'visible' : 'not visible'}`;
  } else if (type === 'url') {
    const url = readPageUrl(session.sessionName);
    passed = url.includes(expected);
    message = `URL was ${url}`;
  } else if (type === 'no-console-errors') {
    const errors = ab('errors', { session: session.sessionName });
    const consoleRaw = ab('console --json', { session: session.sessionName });
    const messages = (JSON.parse(consoleRaw)?.data?.messages ?? []).filter((item: { type?: string }) => item.type === 'error');
    passed = (!errors.trim() || errors.trim() === 'No errors') && messages.length === 0;
    message = passed ? 'No console errors were captured' : 'Console errors were captured';
  } else {
    throw new Error(`Unknown assertion ${type}. Use visible, absent, url, or no-console-errors.`);
  }
  return { type, expected: expected || undefined, passed, message };
}

export function materializeCurlInput(args: string[]): {
  args: string[];
  cleanup: () => void;
} {
  const curlIndex = args.indexOf('--curl');
  const sourcePath = curlIndex >= 0 ? args[curlIndex + 1] : undefined;
  if (
    args[0] !== 'cookies' ||
    args[1] !== 'set' ||
    !sourcePath?.startsWith('/dev/fd/')
  ) {
    return { args, cleanup: () => {} };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-curl-'));
  const materializedPath = path.join(tempDir, 'cookies.txt');
  try {
    fs.copyFileSync(sourcePath, materializedPath);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  return {
    args: args.map((arg, index) => (
      index === curlIndex + 1 ? materializedPath : arg
    )),
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

/**
 * Build the shell command string for agent-browser.
 *
 * For `eval` commands, we need to pass the JS code as a single quoted argument
 * to prevent the shell from interpreting parentheses, brackets, etc.
 * For other commands, simple joining is fine.
 */
export function buildShellCommand(args: string[], sessionName?: string): string {
  if (args[0] === 'eval' && args.length > 1) {
    const jsCode = args.slice(1).join(' ');
    const escaped = jsCode.replace(/'/g, "'\\''");
    return buildAgentBrowserCommand(`eval '${escaped}'`, { session: sessionName });
  }

  const quotedArgs = args.map((arg) => {
    if (/[(){}[\]$`!#&|;<>*? "'\\]/.test(arg)) {
      const escaped = arg.replace(/'/g, "'\\''");
      return `'${escaped}'`;
    }
    return arg;
  });
  return buildAgentBrowserCommand(quotedArgs.join(' '), { session: sessionName });
}

/**
 * Parse an element ref (@eN) from command args.
 */
function parseElementRef(args: string[]): string | null {
  for (const arg of args) {
    const match = arg.match(/@e\d+/);
    if (match) return match[0];
  }
  return null;
}

/**
 * Capture element bounding box and label before action execution.
 *
 * agent-browser's `get box` doesn't support @eN refs, but `get text` and
 * `get attr` do. Strategy:
 * 1. Try `get attr @eN id` — if found, use `get box #<id>` (reliable for inputs)
 * 2. Otherwise try `get text @eN` — use `get box "text=<label>"` (works for links/buttons)
 * 3. Label comes from get text (links/buttons) or get attr fallback chain (inputs)
 *
 * None of these commands invalidate snapshot refs, so the subsequent action still works.
 */
function captureElementData(
  ref: string,
  viewport: { width: number; height: number },
  sessionName?: string,
): SessionLogEntry['element'] | null {
  try {
    let bbox: { x: number; y: number; width: number; height: number } | null = null;
    let label = '';

    // Strategy 1: Try id-based selector (works for inputs with id attributes)
    let elemId = '';
    try { elemId = ab(`get attr ${ref} id`, { session: sessionName }); } catch { /* empty */ }

    if (elemId) {
      try {
        const raw = ab(`get box '#${elemId}'`, { session: sessionName });
        bbox = JSON.parse(raw);
      } catch { /* empty */ }

      // For inputs, get label from associated <label> via eval (doesn't invalidate refs)
      try {
        const raw = ab(
          `eval "document.getElementById('${elemId}')?.labels?.[0]?.textContent||document.getElementById('${elemId}')?.placeholder||document.getElementById('${elemId}')?.getAttribute('aria-label')||''"`,
          { session: sessionName },
        );
        label = JSON.parse(raw) || '';
      } catch { /* empty */ }
    }

    // Strategy 2: Try text-based selector (works for links, buttons)
    if (!bbox) {
      try { label = ab(`get text ${ref}`, { session: sessionName }); } catch { /* empty */ }
      if (!label) {
        try { label = ab(`get attr ${ref} placeholder`, { session: sessionName }); } catch { /* empty */ }
      }
      if (!label) {
        try { label = ab(`get attr ${ref} aria-label`, { session: sessionName }); } catch { /* empty */ }
      }
      if (!label) {
        try { label = ab(`get attr ${ref} name`, { session: sessionName }); } catch { /* empty */ }
      }

      if (label) {
        try {
          const escaped = label.replace(/'/g, "\\'");
          const raw = ab(`get box 'text=${escaped}'`, { session: sessionName });
          bbox = JSON.parse(raw);
        } catch { /* empty */ }
      }
    }

    if (!bbox) return null;

    return {
      label: label || '',
      bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
      viewport,
    };
  } catch {
    return null;
  }
}

/**
 * Check if the action is ref-targeted (click, fill, type with @eN).
 */
function isRefTargetedAction(args: string[]): boolean {
  const cmd = args[0]?.toLowerCase();
  return (cmd === 'click' || cmd === 'fill' || cmd === 'type') && parseElementRef(args) !== null;
}

/**
 * proofshot exec <agent-browser-args...>
 *
 * 1. Read session state to get sessionDir and startedAt
 * 2. For screenshot commands, resolve paths into the session dir
 * 3. For ref-targeted actions, capture element bbox + label BEFORE execution
 * 4. Calculate timestamp relative to session start
 * 5. Append entry to session-log.json
 * 6. Pass through to agent-browser and return its output
 * 7. If action was `set viewport`, update cached viewport in session state
 */
export async function execCommand(args: string[]): Promise<void> {
  const action = args.join(' ');

  // Load session state
  const config = loadConfig();
  setAgentBrowserDefaults({ configPath: config.browser.configPath });
  const outputDir = path.resolve(config.output);
  const session = loadSession(outputDir);

  if (session && !session.recordingActive) {
    console.error(
      'Error: Session has no active recording. Video capture is required.\n' +
        'Run "proofshot stop" to end this session, then start a new one.',
    );
    process.exit(1);
  }

  const materialized = materializeCurlInput(args);

  // Resolve args (screenshot path rewriting)
  let resolvedArgs = materialized.args;
  if (session) {
    resolvedArgs = resolveScreenshotPath(resolvedArgs, session.sessionDir);
  }

  // Capture element data BEFORE execution (element may be gone after click navigation)
  let elementData: SessionLogEntry['element'] | undefined;
  if (session && isRefTargetedAction(args)) {
    const ref = parseElementRef(args)!;
    const viewport = session.viewport || { width: 1280, height: 720 };
    const captured = captureElementData(ref, viewport, session.sessionName);
    if (captured) elementData = captured;
  }

  const started = new Date();
  let success = false;
  let exitStatus = 0;
  let capturedStderr = '';
  let assertion: NonNullable<SessionLogEntry['assertion']> | undefined;

  // Build shell command with proper quoting
  const shellCmd = buildShellCommand(resolvedArgs, session?.sessionName);

  // Pass through to agent-browser
  try {
    let result: string;
    if (args[0] === 'assert' && session) {
      assertion = runAssertion(args, session);
      result = assertion.message;
    } else {
      result = execSync(shellCmd, {
      encoding: 'utf-8',
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    success = assertion ? assertion.passed : true;
    if (assertion && !assertion.passed) {
      exitStatus = 1;
      process.exitCode = 1;
    }
    if (result.trim()) {
      process.stdout.write(result);
      // Ensure trailing newline
      if (!result.endsWith('\n')) {
        process.stdout.write('\n');
      }
    }
  } catch (error: any) {
    // Print stderr and exit with the same code
    const stderr = error?.stderr?.toString?.() || '';
    capturedStderr = redactStderr(stderr || error?.message || 'Unknown error');
    exitStatus = error?.status || 1;
    const stdout = error?.stdout?.toString?.() || '';
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    const hint = describeSelectorSyntaxError(args, stderr);
    if (hint) process.stderr.write(hint);
    process.exitCode = exitStatus;
  } finally {
    materialized.cleanup();
    if (session) {
      const finished = new Date();
      const entry: SessionLogEntry = {
        action,
        timestamp: started.toISOString(),
        startedAt: started.toISOString(),
        finishedAt: finished.toISOString(),
        relativeTimeSec: parseFloat(((started.getTime() - new Date(session.startedAt).getTime()) / 1000).toFixed(1)),
        exitStatus,
        success,
        ...(capturedStderr ? { stderr: capturedStderr } : {}),
        ...(elementData ? { element: elementData } : {}),
        ...(assertion ? { assertion } : {}),
      };
      try { entry.resultingUrl = readPageUrl(session.sessionName); } catch { /* browser unavailable */ }
      if (args[0] === 'screenshot') {
        const screenshotPath = resolvedArgs.find((arg) => arg.endsWith('.png'));
        const dimensions = screenshotPath ? pngDimensions(screenshotPath) : undefined;
        if (screenshotPath && dimensions) entry.screenshot = { path: screenshotPath, ...dimensions };
      }
      appendLog(session.sessionDir, entry);
      if (assertion) {
        const assertions = loadSessionLog(session.sessionDir).filter((item) => item.assertion).map((item) => item.assertion);
        writeJsonAtomic(path.join(session.sessionDir, RESULT_FILENAME), { assertions, passed: assertions.every((item) => item?.passed) });
      }
    }
  }

  // If the action was `set viewport`, update cached viewport in session state
  if (session && args[0] === 'set' && args[1] === 'viewport') {
    let actualViewport: { width: number; height: number } | null = null;
    try {
      const vpJson = ab("eval 'JSON.stringify({width: window.innerWidth, height: window.innerHeight})'", {
        session: session.sessionName,
      });
      const vp = parseBrowserValue(vpJson) as { width?: unknown; height?: unknown };
      if (!vp || typeof vp.width !== 'number' || typeof vp.height !== 'number' || !Number.isInteger(vp.width) || !Number.isInteger(vp.height)) throw new Error('invalid viewport response');
      const verifiedViewport = { width: vp.width, height: vp.height };
      session.viewport = verifiedViewport;
      session.viewportChanges.push({ ...verifiedViewport, timestamp: new Date().toISOString() });
      actualViewport = verifiedViewport;
      saveSession(session);
    } catch {
      // Non-critical — viewport cache stays stale
    }
    const requestedWidth = Number(args[2]);
    const requestedHeight = Number(args[3]);
    if (!actualViewport || actualViewport.width !== requestedWidth || actualViewport.height !== requestedHeight) {
      console.error(
        `Error: agent-browser reported success but the viewport remained ` +
          `${actualViewport?.width ?? 'undefined'}x${actualViewport?.height ?? 'undefined'}; requested ` +
          `${requestedWidth}x${requestedHeight}.`,
      );
      process.exitCode = 1;
    }
  }
}

/** Playwright-style engine prefixes that agent-browser's selectors do not accept. */
const PLAYWRIGHT_SELECTOR_PREFIXES = ['text=', 'role=', 'label=', 'placeholder=', 'alt=', 'title=', 'testid='];

/**
 * agent-browser reports a missing element the same way whether the selector was
 * wrong or the element genuinely isn't there. Agents read that as "the page is
 * gone" and re-navigate, which never helps. When the selector is Playwright
 * syntax, say so and give the two forms that do work.
 */
export function describeSelectorSyntaxError(args: string[], stderr: string): string | null {
  if (!/not found/i.test(stderr)) return null;

  const command = args[0]?.toLowerCase();
  if (command !== 'click' && command !== 'fill' && command !== 'type' && command !== 'hover') {
    return null;
  }

  const selector = args[1];
  if (!selector) return null;

  const prefix = PLAYWRIGHT_SELECTOR_PREFIXES.find((candidate) => selector.startsWith(candidate));
  if (!prefix) return null;

  const locator = prefix.slice(0, -1);
  const value = selector.slice(prefix.length);

  return (
    `\nHint: "${selector}" is Playwright selector syntax, which agent-browser does not accept.\n` +
    `The page is probably fine — re-navigating will not fix this. Use either:\n` +
    `  proofshot exec find ${locator} ${value} ${command}\n` +
    `  proofshot exec snapshot -i    # then target the @eN ref it prints\n`
  );
}
