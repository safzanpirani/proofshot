import { expect, it } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { fileURLToPath } from 'url';

it('built CLI reports startup stderr and retains the full log after rollback', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-start-cli-'));
  const cli = fileURLToPath(new URL('../../dist/bin/proofshot.js', import.meta.url));
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    fs.writeFileSync(path.join(directory, 'proofshot.config.json'), JSON.stringify({
      output: './artifacts', devServer: { port, startupTimeout: 1500 },
    }));
    fs.writeFileSync(path.join(directory, 'startup-fixture.cjs'),
      'process.stdout.write("FIRST_OUTPUT\\n" + "x".repeat(100000) + "\\n", () => ' +
      'process.stderr.write("ERR_PNPM_UNSAFE_MODULES_DIR\\n"));process.exitCode = 1;');
    let failure: any;
    try {
      await promisify(execFile)(process.execPath, [cli, 'start', '--run', 'node startup-fixture.cjs'], {
        cwd: directory, timeout: 15000,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure?.code).toBe(1);
    expect(failure.stderr).toContain('ERR_PNPM_UNSAFE_MODULES_DIR');
    expect(failure.stderr).toContain('Server log:');
    const output = path.join(directory, 'artifacts');
    expect(fs.existsSync(path.join(output, '.session.json'))).toBe(false);
    expect(fs.existsSync(path.join(output, '.session-start.lock'))).toBe(false);
    const sessions = fs.readdirSync(output).filter((entry) => fs.statSync(path.join(output, entry)).isDirectory());
    expect(sessions).toHaveLength(1);
    const session = path.join(output, sessions[0]);
    const log = fs.readFileSync(path.join(session, 'server.log'), 'utf-8');
    expect(log).toContain('FIRST_OUTPUT');
    expect(log).toContain('x'.repeat(100000));
    expect(log).toContain('ERR_PNPM_UNSAFE_MODULES_DIR');
    expect(fs.existsSync(path.join(session, 'metadata.json'))).toBe(true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
