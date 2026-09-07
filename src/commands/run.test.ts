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

  it.each(['set', 'open'])('stops immediately after failed %s setup, even without steps', async (command) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proofshot-run-setup-'));
    const scenarioPath = path.join(directory, 'scenario.json');
    fs.writeFileSync(scenarioPath, JSON.stringify({ port: 3000, url: '/', viewports: [[390, 844], [1280, 720]], steps: [] }));
    mocks.startCommand.mockResolvedValue(true);
    mocks.execCommand.mockImplementation(async (args: string[]) => {
      if (args[0] === command) process.exitCode = 1;
    });
    try {
      await expect(runCommand(scenarioPath)).rejects.toThrow(/Scenario .* failed/);
      expect(mocks.execCommand).toHaveBeenCalledTimes(command === 'set' ? 1 : 2);
      expect(mocks.stopCommand).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
