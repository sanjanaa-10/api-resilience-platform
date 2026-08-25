import { spawn } from 'child_process';

const CHILDREN: NodeJS.Process[] = [];

function startBackend(): NodeJS.Process {
  const proc = spawn('node', ['dist/backend/src/server.js'], {
    stdio: 'inherit',
    env: { ...process.env, PORT: process.env.PORT || '4000' },
  });
  CHILDREN.push(proc);
  return proc;
}

function startService(name: string, script: string, port: number): NodeJS.Process {
  const proc = spawn('node', [script], {
    stdio: 'inherit',
    env: { ...process.env, SERVICE_NAME: name, PORT: String(port) },
  });
  CHILDREN.push(proc);
  return proc;
}

function handleShutdown(signal: string): void {
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