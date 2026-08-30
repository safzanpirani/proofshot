import * as fs from 'fs';
import * as path from 'path';
import { startCommand } from './start.js';
import { execCommand } from './exec.js';
import { stopCommand } from './stop.js';

interface Scenario {
  run?: string;
  port: number;
  url?: string;
  viewports: Array<[number, number]>;
  steps: Array<Record<string, unknown>>;
  failOnConsoleErrors?: boolean;
  failOnServerErrors?: boolean;
  description?: string;
}

function loadScenario(filePath: string): Scenario {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<Scenario>;
  if (!Number.isInteger(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65535) throw new Error('scenario.port must be a valid port');
  if (!Array.isArray(parsed.viewports) || parsed.viewports.length === 0 || parsed.viewports.some((viewport) => !Array.isArray(viewport) || viewport.length !== 2 || viewport.some((value) => !Number.isInteger(value) || value < 1))) throw new Error('scenario.viewports must contain [width, height] pairs');
  if (!Array.isArray(parsed.steps)) throw new Error('scenario.steps must be an array');
  return parsed as Scenario;
}

export async function runCommand(scenarioPath: string): Promise<void> {
  const resolved = path.resolve(scenarioPath);
  const scenario = loadScenario(resolved);
  const started = await startCommand({
    run: scenario.run,
    port: scenario.port,
    url: scenario.url ? `http://localhost:${scenario.port}${scenario.url}` : undefined,
    description: scenario.description || `Scenario ${path.basename(resolved)}`,
    scenarioManifest: resolved,
  });
  if (!started) {
    process.exitCode = 1;
    return;
  }
  let actionFailed = false;
  try {
    for (const [width, height] of scenario.viewports) {
      await execCommand(['set', 'viewport', String(width), String(height)]);
      if (scenario.url) await execCommand(['open', `http://localhost:${scenario.port}${scenario.url}`]);
      for (const step of scenario.steps) {
        if (typeof step.assertVisible === 'string') await execCommand(['assert', 'visible', step.assertVisible]);
        else if (typeof step.assertAbsent === 'string') await execCommand(['assert', 'absent', step.assertAbsent]);
        else if (typeof step.assertUrl === 'string') await execCommand(['assert', 'url', step.assertUrl]);
        else if (step.assertNoConsoleErrors === true) await execCommand(['assert', 'no-console-errors']);
        else if (typeof step.screenshot === 'string') {
          const name = scenario.viewports.length > 1 ? `${width}x${height}-${step.screenshot}` : step.screenshot;
          await execCommand(['screenshot', ...(step.fullPage === false ? ['--viewport-only'] : []), name]);
        } else throw new Error(`Unsupported scenario step: ${JSON.stringify(step)}`);
        if (process.exitCode) throw new Error('Scenario action failed');
      }
    }
  } catch (error) {
    actionFailed = true;
    throw error;
  } finally {
    await stopCommand({
      allowIncomplete: false,
      failOnConsoleErrors: scenario.failOnConsoleErrors,
      failOnServerErrors: scenario.failOnServerErrors,
    });
    if (actionFailed) process.exitCode = 1;
  }
}
