'use strict';

/**
 * Zero-dependency launcher for all three simulated services.
 * Each service runs in its own process via `node --import tsx --watch`.
 * Structured log lines already carry a `service` field; a colored tag is
 * prefixed as well so interleaved terminals stay readable.
 *
 * Stop everything with Ctrl+C.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

const SERVICES = [
  { name: 'payment-service', entry: 'payment-service/src/server.ts', tag: '\x1b[36m[payment]\x1b[0m' },
  { name: 'ai-service', entry: 'ai-service/src/server.ts', tag: '\x1b[35m[ai]\x1b[0m' },
  {
    name: 'ai-fallback-service',
    entry: 'ai-fallback-service/src/server.ts',
    tag: '\x1b[35m[ai-fb]\x1b[0m',
  },
  {
    name: 'notification-service',
    entry: 'notification-service/src/server.ts',
    tag: '\x1b[33m[notify]\x1b[0m',
  },
];

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exit(0);
}

const children = SERVICES.map((service) => {
  const child = spawn(process.execPath, ['--import', 'tsx', '--watch', service.entry], {
    cwd: ROOT,
    env: process.env,
  });

  const prefixLines = (chunk) =>
    String(chunk)
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => `${service.tag} ${line}`)
      .join('\n') + '\n';

  child.stdout.on('data', prefixLines);
  child.stderr.on('data', prefixLines);

  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.log(`${service.tag} exited (code ${code}) — stopping all services`);
      shutdown();
    }
  });

  console.log(`${service.tag} starting (${service.entry})`);
  return child;
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
