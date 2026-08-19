/**
 * Detached log pump.
 *
 * Runs a dev server command and appends its output to a log file, one
 * `<epoch_ms>\t<line>` record per line, so the viewer can sync server logs to
 * the video timeline.
 *
 * This exists as a separate process so `proofshot start` can exit. Piping the
 * server's stdio through the `start` process kept its event loop alive forever,
 * which hung every agent-driven session. The pump owns the pipes instead, and
 * `start` detaches from it.
 *
 * Usage: log-pump <logPath> <command...>
 */
import { spawn } from 'child_process';
import * as fs from 'fs';

const [, , logPath, ...commandParts] = process.argv;

if (!logPath || commandParts.length === 0) {
  console.error('usage: log-pump <logPath> <command...>');
  process.exit(2);
}

const command = commandParts.join(' ');
const shell = process.platform === 'win32' ? true : '/bin/sh';
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

const child = spawn(command, { stdio: ['ignore', 'pipe', 'pipe'], shell });

/** Emit whole lines only, so a timestamp always starts a record. */
function pump(stream: NodeJS.ReadableStream | null): void {
  if (!stream) return;
  let buffer = '';
  stream.setEncoding('utf-8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      logStream.write(`${Date.now()}\t${line}\n`);
    }
  });
  stream.on('end', () => {
    if (buffer) logStream.write(`${Date.now()}\t${buffer}\n`);
  });
}

pump(child.stdout);
pump(child.stderr);

// The pump is useless without its child; die together so `stop` only has to
// kill one process tree.
child.on('exit', (code) => {
  logStream.end(() => process.exit(code ?? 0));
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
    process.exit(0);
  });
}
