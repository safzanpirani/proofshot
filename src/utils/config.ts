import * as fs from 'fs';
import * as path from 'path';

export interface DevServerConfig {
  port: number;
  startupTimeout: number;
}

export interface ViewportConfig {
  width: number;
  height: number;
}

export interface BrowserConfig {
  configPath?: string;
  executablePath?: string;
  ignoreHttpsErrors: boolean;
}

export interface ProofShotConfig {
  devServer: DevServerConfig;
  output: string;
  defaultPages: string[];
  viewport: ViewportConfig;
  headless: boolean;
  browser: BrowserConfig;
}

const CONFIG_FILENAME = 'proofshot.config.json';

const DEFAULT_CONFIG: ProofShotConfig = {
  devServer: {
    port: 3000,
    startupTimeout: 30000,
  },
  output: './proofshot-artifacts',
  defaultPages: ['/'],
  viewport: { width: 1280, height: 720 },
  headless: true,
  browser: {
    ignoreHttpsErrors: false,
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max) {
    throw new Error(`${field} must be an integer from 1 to ${max}`);
  }
  return Number(value);
}

export function validateConfig(value: unknown, source = CONFIG_FILENAME): ProofShotConfig {
  if (!isObject(value)) throw new Error(`${source}: configuration must be a JSON object`);
  const devServer = value.devServer === undefined ? {} : value.devServer;
  const viewport = value.viewport === undefined ? {} : value.viewport;
  const browser = value.browser === undefined ? {} : value.browser;
  if (!isObject(devServer)) throw new Error(`${source}: devServer must be an object`);
  if (!isObject(viewport)) throw new Error(`${source}: viewport must be an object`);
  if (!isObject(browser)) throw new Error(`${source}: browser must be an object`);

  const output = value.output ?? DEFAULT_CONFIG.output;
  if (typeof output !== 'string' || !output.trim() || output.includes('\0')) {
    throw new Error(`${source}: output must be a non-empty path`);
  }
  const defaultPages = value.defaultPages ?? DEFAULT_CONFIG.defaultPages;
  if (!Array.isArray(defaultPages) || defaultPages.some((page) => typeof page !== 'string' || !page.trim())) {
    throw new Error(`${source}: defaultPages must contain non-empty URL paths`);
  }
  for (const page of defaultPages as string[]) {
    try { new URL(page, 'http://localhost'); } catch { throw new Error(`${source}: invalid URL in defaultPages: ${page}`); }
  }
  const headless = value.headless ?? DEFAULT_CONFIG.headless;
  if (typeof headless !== 'boolean') throw new Error(`${source}: headless must be a boolean`);
  const ignoreHttpsErrors = browser.ignoreHttpsErrors ?? DEFAULT_CONFIG.browser.ignoreHttpsErrors;
  if (typeof ignoreHttpsErrors !== 'boolean') throw new Error(`${source}: browser.ignoreHttpsErrors must be a boolean`);
  for (const key of ['configPath', 'executablePath'] as const) {
    if (browser[key] !== undefined && (typeof browser[key] !== 'string' || !browser[key])) {
      throw new Error(`${source}: browser.${key} must be a non-empty path`);
    }
  }
  return {
    devServer: {
      port: positiveInteger(devServer.port ?? DEFAULT_CONFIG.devServer.port, `${source}: devServer.port`, 65535),
      startupTimeout: positiveInteger(devServer.startupTimeout ?? DEFAULT_CONFIG.devServer.startupTimeout, `${source}: devServer.startupTimeout`),
    },
    output,
    defaultPages: [...defaultPages] as string[],
    viewport: {
      width: positiveInteger(viewport.width ?? DEFAULT_CONFIG.viewport.width, `${source}: viewport.width`, 16384),
      height: positiveInteger(viewport.height ?? DEFAULT_CONFIG.viewport.height, `${source}: viewport.height`, 16384),
    },
    headless,
    browser: {
      configPath: browser.configPath as string | undefined,
      executablePath: browser.executablePath as string | undefined,
      ignoreHttpsErrors,
    },
  };
}

/**
 * Find the config file by walking up from cwd.
 */
export function findConfigPath(startDir?: string): string | null {
  let dir = startDir || process.cwd();
  while (true) {
    const configPath = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(configPath)) return configPath;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Load config from disk, merging with defaults.
 */
export function loadConfig(startDir?: string): ProofShotConfig {
  const configPath = findConfigPath(startDir);
  if (!configPath) return validateConfig({});

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = validateConfig(JSON.parse(raw), configPath);
    const configDir = path.dirname(configPath);
    const resolvedBrowser = {
      ...parsed.browser,
    };
    if (resolvedBrowser.configPath) {
      resolvedBrowser.configPath = path.resolve(configDir, resolvedBrowser.configPath);
    }
    return {
      ...parsed,
      browser: resolvedBrowser,
    };
  } catch (error) {
    throw new Error(`Failed to load ProofShot configuration ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Write config to disk.
 */
export function writeConfig(
  config: ProofShotConfig,
  dir?: string,
): string {
  const configPath = path.join(dir || process.cwd(), CONFIG_FILENAME);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return configPath;
}

/**
 * Check if a config file exists in the current project.
 */
export function configExists(dir?: string): boolean {
  return findConfigPath(dir) !== null;
}
