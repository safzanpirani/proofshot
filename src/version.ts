import * as fs from 'fs';

declare const __PROOFSHOT_VERSION__: string | undefined;
declare const __PROOFSHOT_COMMIT__: string | undefined;

function readPackageVersion(): string {
  const packageJson = new URL('../package.json', import.meta.url);
  const contents = fs.readFileSync(packageJson, 'utf-8');
  const parsed = JSON.parse(contents) as { version?: string };

  if (!parsed.version) {
    throw new Error('package.json is missing a version field');
  }

  return parsed.version;
}

export const PROOFSHOT_VERSION =
  typeof __PROOFSHOT_VERSION__ !== 'undefined'
    ? __PROOFSHOT_VERSION__
    : readPackageVersion();

export const PROOFSHOT_COMMIT =
  typeof __PROOFSHOT_COMMIT__ !== 'undefined' && __PROOFSHOT_COMMIT__ !== 'unknown'
    ? __PROOFSHOT_COMMIT__
    : null;
