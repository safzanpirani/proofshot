import { abArgs } from '../utils/exec.js';
import type { BrowserConfig, ViewportConfig } from '../utils/config.js';

export function buildOpenBrowserArgs(
  url: string,
  headless = true,
  browserConfig?: BrowserConfig,
): string[] {
  const args = ['open', url];
  if (!headless) args.push('--headed');
  if (browserConfig?.ignoreHttpsErrors) args.push('--ignore-https-errors');
  if (browserConfig?.executablePath) args.push('--executable-path', browserConfig.executablePath);
  return args;
}

export function buildOpenBrowserCommand(
  url: string,
  headless = true,
  browserConfig?: BrowserConfig,
): string {
  const flags: string[] = [];

  if (!headless) flags.push('--headed');
  if (browserConfig?.ignoreHttpsErrors) flags.push('--ignore-https-errors');
  if (browserConfig?.executablePath) flags.push(`--executable-path "${browserConfig.executablePath.replace(/"/g, '\\"')}"`);

  const suffix = flags.length > 0 ? ` ${flags.join(' ')}` : '';
  return `open ${url}${suffix}`;
}

/**
 * Initialize a browser session.
 * Opens the browser and sets viewport dimensions.
 */
export function openBrowser(
  url: string,
  viewport: ViewportConfig,
  headless = true,
  sessionName?: string,
  browserConfig?: BrowserConfig,
): void {
  abArgs(buildOpenBrowserArgs(url, headless, browserConfig), { timeoutMs: 60000, session: sessionName });
  abArgs(['set', 'viewport', String(viewport.width), String(viewport.height)], { session: sessionName });
}

/**
 * Close the browser session.
 */
export function closeBrowser(sessionName?: string): void {
  try {
    abArgs(['close'], { session: sessionName });
  } catch {
    // Browser may already be closed — that's fine
  }
}

/**
 * Check if agent-browser is installed and accessible.
 */
export function checkAgentBrowser(): boolean {
  try {
    abArgs(['--version'], 5000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get any console errors from the current page.
 */
export function getConsoleErrors(sessionName?: string): string {
  return abArgs(['errors'], { session: sessionName });
}

/**
 * Get console output from the current page.
 */
export function getConsoleOutput(sessionName?: string): string {
  return abArgs(['console'], { session: sessionName });
}

export interface ConsoleMessage {
  text: string;
  timestamp: number; // epoch ms
  type: string; // log, warn, error, etc.
}

/**
 * Get console output as structured JSON with per-message timestamps.
 */
export function getConsoleOutputJson(sessionName?: string): ConsoleMessage[] {
  const raw = abArgs(['console', '--json'], { session: sessionName });
  const parsed = JSON.parse(raw);
  const messages = parsed?.data?.messages ?? parsed;
  if (!Array.isArray(messages)) throw new Error('agent-browser returned malformed console data');
  return messages;
}

/**
 * Get the current page title.
 */
export function getPageTitle(sessionName?: string): string {
  try {
    return abArgs(['get', 'title'], { session: sessionName });
  } catch {
    return '';
  }
}

/**
 * Get the current page URL.
 */
export function getPageUrl(sessionName?: string): string {
  try {
    const raw = abArgs(['eval', 'window.location.href'], { session: sessionName });
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return '';
  }
}
