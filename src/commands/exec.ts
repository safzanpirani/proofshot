import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../utils/config.js';
import { abArgs, setAgentBrowserDefaults } from '../utils/exec.js';
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

export interface SessionLogReadResult {
  entries: SessionLogEntry[];
  malformedLines: number[];
}

/** Read all complete JSONL records and report malformed lines by 1-based line number. */
export function readSessionLog(sessionDir: string): SessionLogReadResult {
  const logPath = path.join(sessionDir, SESSION_LOG_FILENAME);
  if (!fs.existsSync(logPath)) return { entries: [], malformedLines: [] };

  const entries: SessionLogEntry[] = [];
  const malformedLines: number[] = [];
  const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      entries.push(JSON.parse(line) as SessionLogEntry);
    } catch {
      malformedLines.push(index + 1);
    }
  });
  return { entries, malformedLines };
}

/**
 * Load existing session log entries from disk.
 */
export function loadSessionLog(sessionDir: string): SessionLogEntry[] {
  return readSessionLog(sessionDir).entries;
}

/**
 * For screenshot commands, resolve relative paths into the session directory
 * so agents can just say `proofshot exec screenshot step-name.png`.
 */
export function resolveScreenshotPath(args: string[], sessionDir: string): string[] {
  if (args[0] !== 'screenshot' || args.length < 2) return args;

  const viewportOnly = args.includes('--viewport-only');
  const normalized = args.filter((arg) => arg !== '--viewport-only');
  const withMode = viewportOnly || normalized.includes('--full') ? normalized : [...normalized, '--full'];
  const optionsWithValues = new Set([
    '--screenshot-dir',
    '--screenshot-format',
    '--screenshot-quality',
  ]);
  const positional: string[] = [];
  for (let index = 1; index < normalized.length; index += 1) {
    const arg = normalized[index];
    if (optionsWithValues.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith('-')) positional.push(arg);
  }
  const screenshotPath = positional.at(-1);
  if (!screenshotPath) return withMode;

  // If it's already absolute, leave it alone
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
  const value = parseBrowserValue(abArgs(['eval', 'window.location.href'], { session: sessionName }));
  if (typeof value !== 'string') throw new Error('agent-browser returned an invalid page URL');
  return value;
}

export function formatLoggedAction(args: readonly string[]): string {
  const command = args[0]?.toLowerCase();
  if (command === 'fill') {
    return [args[0], args[1], '[REDACTED]'].filter((value) => value !== undefined).join(' ');
  }
  if (command === 'type') {
    const target = args[1]?.match(/^@e\d+$/) ? args[1] : undefined;
    return [args[0], target, '[REDACTED]'].filter((value) => value !== undefined).join(' ');
  }
  return args.join(' ');
}

function redactEnteredValues(value: string, args: readonly string[]): string {
  const command = args[0]?.toLowerCase();
  const entered = command === 'fill'
    ? args.slice(2)
    : command === 'type'
      ? (args[1]?.match(/^@e\d+$/) ? args.slice(2) : args.slice(1))
      : [];
  const values = [...new Set([entered.join(' '), ...entered])]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const variants = values.flatMap((item) => {
    const encoded = encodeURIComponent(item);
    return [item, encoded, encoded.replace(/%20/g, '+'), JSON.stringify(item).slice(1, -1)];
  });
  return [...new Set(variants)]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce((redacted, item) => redacted.split(item).join('[REDACTED]'), value);
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
  const type = args[1]?.trim() || 'unknown';
  const expected = args.slice(2).join(' ').trim();
  let passed = false;
  let message = '';
  if (type === 'visible' || type === 'absent') {
    if (!expected) return { type, passed: false, message: `assert ${type} requires text` };
    const script = `(() => {
      const wanted = ${JSON.stringify(expected)};
      const matches = [...document.querySelectorAll('body *')].filter((element) => element.textContent?.includes(wanted));
      const smallest = matches.filter((element) => !matches.some((other) => other !== element && element.contains(other)));
      const visible = (element) => {
        if (typeof element.checkVisibility === 'function') {
          return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        }
        for (let current = element; current; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (current.hidden || style.display === 'none' || style.visibility === 'hidden' ||
              style.visibility === 'collapse' || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) return false;
        }
        return element.getClientRects().length > 0;
      };
      return smallest.some(visible);
    })()`;
    const visible = Boolean(parseBrowserValue(abArgs(['eval', script], { session: session.sessionName })));
    passed = type === 'visible' ? visible : !visible;
    message = `${JSON.stringify(expected)} was ${visible ? 'visible' : 'not visible'}`;
  } else if (type === 'url') {
    if (!expected) return { type, passed: false, message: 'assert url requires a non-empty URL fragment' };
    const url = readPageUrl(session.sessionName);
    passed = url.includes(expected);
    message = `URL was ${url}`;
  } else if (type === 'no-console-errors') {
    if (expected) return { type, expected, passed: false, message: 'assert no-console-errors does not accept a value' };
    const errors = abArgs(['errors'], { session: session.sessionName });
    const consoleRaw = abArgs(['console', '--json'], { session: session.sessionName });
    const messages = (JSON.parse(consoleRaw)?.data?.messages ?? []).filter((item: { type?: string }) => item.type === 'error');
    passed = (!errors.trim() || errors.trim() === 'No errors') && messages.length === 0;
    message = passed ? 'No console errors were captured' : 'Console errors were captured';
  } else {
    return {
      type,
      ...(expected ? { expected } : {}),
      passed: false,
      message: `Unknown assertion ${JSON.stringify(type)}. Use visible, absent, url, or no-console-errors.`,
    };
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
    try { elemId = abArgs(['get', 'attr', ref, 'id'], { session: sessionName }); } catch { /* empty */ }

    if (elemId) {
      try {
        const raw = abArgs(['get', 'box', `#${elemId}`], { session: sessionName });
        bbox = JSON.parse(raw);
      } catch { /* empty */ }

      // For inputs, get label from associated <label> via eval (doesn't invalidate refs)
      try {
        const expression = `(() => { const element = document.getElementById(${JSON.stringify(elemId)}); return element?.labels?.[0]?.textContent || element?.placeholder || element?.getAttribute('aria-label') || ''; })()`;
        const raw = abArgs(
          ['eval', expression],
          { session: sessionName },
        );
        label = JSON.parse(raw) || '';
      } catch { /* empty */ }
    }

    // Strategy 2: Try text-based selector (works for links, buttons)
    if (!bbox) {
      try { label = abArgs(['get', 'text', ref], { session: sessionName }); } catch { /* empty */ }
      if (!label) {
        try { label = abArgs(['get', 'attr', ref, 'placeholder'], { session: sessionName }); } catch { /* empty */ }
      }
      if (!label) {
        try { label = abArgs(['get', 'attr', ref, 'aria-label'], { session: sessionName }); } catch { /* empty */ }
      }
      if (!label) {
        try { label = abArgs(['get', 'attr', ref, 'name'], { session: sessionName }); } catch { /* empty */ }
      }

      if (label) {
        try {
          const raw = abArgs(['get', 'box', `text=${label}`], { session: sessionName });
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
 * 5. Pass through to agent-browser and return its output
 * 6. Append the outcome to session-log.jsonl
 * 7. If action was `set viewport`, update cached viewport in session state
 */
export async function execCommand(args: string[]): Promise<void> {
  const action = formatLoggedAction(args);

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

  // Pass through to agent-browser
  try {
    let result: string;
    if (args[0] === 'assert' && session) {
      assertion = runAssertion(args, session);
      result = assertion.message;
    } else {
      result = abArgs(resolvedArgs, { timeoutMs: 60000, session: session?.sessionName });
    }
    success = assertion ? assertion.passed : true;
    if (assertion && !assertion.passed) {
      exitStatus = 1;
      process.exitCode = 1;
    }
    if (assertion && !assertion.passed) {
      process.stderr.write(`Error: ${result}\n`);
    } else if (result.trim()) {
      process.stdout.write(result);
      // Ensure trailing newline
      if (!result.endsWith('\n')) {
        process.stdout.write('\n');
      }
    }
  } catch (error: any) {
    // Print stderr and exit with the same code
    const processError = error?.cause ?? error;
    const stderr = processError?.stderr?.toString?.() || '';
    const storedError = stderr || ((args[0] === 'fill' || args[0] === 'type')
      ? 'Browser command failed'
      : error?.message || 'Unknown error');
    capturedStderr = redactStderr(redactEnteredValues(storedError, args));
    exitStatus = processError?.status || 1;
    const stdout = processError?.stdout?.toString?.() || '';
    if (stdout) process.stdout.write(redactEnteredValues(stdout, args));
    if (stderr) process.stderr.write(redactEnteredValues(stderr, args));
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
      try {
        entry.resultingUrl = redactEnteredValues(readPageUrl(session.sessionName), args);
      } catch { /* browser unavailable */ }
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
      const vpJson = abArgs(['eval', 'JSON.stringify({width: window.innerWidth, height: window.innerHeight})'], {
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
