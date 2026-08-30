import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from './run.js';

const mocks = vi.hoisted(() => ({
  startCommand: vi.fn(),
  execCommand: vi.fn(),
  stopCommand: vi.fn(),
}));

vi.mock('./start.js', () => ({ startCommand: mocks.startCommand }));
vi.mock('./exec.js', () => ({ execCommand: mocks.execCommand }));
vi.mock('./stop.js', () => ({ stopCommand: mocks.stopCommand }));

describe('runCommand', () => {
  afterEach(() => {
    process.exitCode = undefined;
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it('aborts without actions or cleanup when start does not acquire a session', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-run-duplicate-'));
    const scenarioPath = path.join(tempDir, 'scenario.json');
    fs.writeFileSync(scenarioPath, JSON.stringify({
      port: 3000,
      viewports: [[1280, 720]],
      steps: [{ screenshot: 'home.png' }],
    }));
    mocks.startCommand.mockResolvedValue(false);

    await runCommand(scenarioPath);

    expect(process.exitCode).toBe(1);
    expect(mocks.execCommand).not.toHaveBeenCalled();
    expect(mocks.stopCommand).not.toHaveBeenCalled();
  });
});
