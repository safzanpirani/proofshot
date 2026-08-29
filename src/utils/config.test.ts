import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('merges nested browser config with defaults', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-config-test-'));
    fs.writeFileSync(
      path.join(tempDir, 'proofshot.config.json'),
      JSON.stringify({
        browser: {
          executablePath: '/tmp/chrome',
        },
      }),
    );

    expect(loadConfig(tempDir).browser).toEqual({
      configPath: undefined,
      executablePath: '/tmp/chrome',
      ignoreHttpsErrors: false,
    });
  });

  it('resolves browser config paths relative to proofshot.config.json', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-browser-config-path-'));
    fs.writeFileSync(
      path.join(tempDir, 'proofshot.config.json'),
      JSON.stringify({
        browser: {
          configPath: './agent-browser.local.json',
        },
      }),
    );

    expect(loadConfig(tempDir).browser).toEqual({
      configPath: path.join(tempDir, 'agent-browser.local.json'),
      executablePath: undefined,
      ignoreHttpsErrors: false,
    });
  });

  it('fails with the config path when JSON is malformed', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-invalid-json-'));
    fs.writeFileSync(path.join(tempDir, 'proofshot.config.json'), '{ invalid');
    expect(() => loadConfig(tempDir)).toThrow(/Failed to load ProofShot configuration.*proofshot\.config\.json/);
  });

  it('rejects invalid execution parameters instead of replacing them with defaults', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-invalid-port-'));
    fs.writeFileSync(path.join(tempDir, 'proofshot.config.json'), JSON.stringify({ devServer: { port: 0 } }));
    expect(() => loadConfig(tempDir)).toThrow('devServer.port');
  });
});
