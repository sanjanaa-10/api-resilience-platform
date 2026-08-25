import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

const REPO_ROOT = process.cwd();
const IS_WINDOWS = process.platform === 'win32';

const CHILDREN: ChildProcess[] = [];

function createChildEnv(serviceType: 'backend' | 'simulator'): Record<string, string> {
  const base = { ...process.env };
  const nodePath = IS_WINDOWS
    ? join(REPO_ROOT, serviceType === 'backend' ? 'backend' : 'services', 'node_modules')
    : join(REPO_ROOT, serviceType === 'backend' ? 'backend' : 'services', 'node_modules');
  if (nodePath) {
    base.NODE_PATH = nodePath;
  }
  return base;
}

function startBackend(): ChildProcess {
  const proc = spawn('node', ['dist/backend/src/server.js'], {
    stdio: 'inherit',
    env: createChildEnv('backend'),
  });
  CHILDREN.push(proc);
  return proc;
}

function startService(name: string, script: string, port: number): ChildProcess {
  const proc = spawn('node', [script], {
    stdio: 'inherit',
    env: createChildEnv('simulator'),
  });
  CHILDREN.push(proc);
  return proc;
}

function handleShutdown(signal: NodeJS.Signals): void {
  console.log(`Received ${signal}, shutting down all processes...`);
  CHILDREN.forEach((child) => {
    child.kill(signal);
  });
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// Start all 4 simulators on fixed ports (compiled dist JS)
// Paths are absolute-relative from project root so launcher works regardless of cwd
startService('payment', 'dist/services/payment-service/src/server.js', 4101);
startService('ai-primary', 'dist/services/ai-service/src/server.js', 4102);
startService('notification', 'dist/services/notification-service/src/server.js', 4103);
startService('ai-fallback', 'dist/services/ai-fallback-service/src/server.js', 4104);

// Start backend gateway on process.env.PORT (Render provides dynamically)
startBackend();