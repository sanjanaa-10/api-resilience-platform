'use strict';

/**
 * Live end-to-end verification for Step 6 — circuit breaker.
 * (Retargeted in Step 7 from ai -> payment: /api/ai/test now sits behind a
 * failover GROUP whose fallback would mask primary failures, while
 * /api/payment/test remains a singleton group with pure breaker semantics.)
 *
 * Zero new dependencies: plain Node (>=20) + global fetch.
 * Spawns the three simulated upstreams plus the gateway, then walks the
 * full state machine against a REAL running stack:
 *
 *   T1 normal traffic            -> payment circuit CLOSED
 *   T2 repeated upstream 503s    -> threshold reached, CLOSED -> OPEN
 *   T3 fail fast while OPEN      -> instant 503 CIRCUIT_OPEN (vs slow proxy path)
 *   T4 recovery                  -> OPEN -> HALF_OPEN -> CLOSED after reset
 *   T5 probe fails again         -> HALF_OPEN -> OPEN
 *   T6 isolation                 -> notification stays CLOSED while payment is OPEN
 *
 * Run from backend/:  node scripts/e2e-circuit-breaker.cjs
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');

const SERVICES_ROOT = path.resolve(__dirname, '..', '..', 'services');
const BACKEND_ROOT = path.resolve(__dirname, '..');

const GATEWAY = 'http://localhost:4000';
const PAYMENT = 'http://localhost:4101';

const SIMULATORS = [
  ['payment-service', 'payment-service/src/server.ts'],
  ['ai-service', 'ai-service/src/server.ts'],
  ['notification-service', 'notification-service/src/server.ts'],
];

const children = [];
let passed = 0;
let failed = 0;
let LOG_DIR = '';

function start(tag, cwd, args) {
  const logPath = path.join(LOG_DIR, `${tag}.log`);
  const out = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: ['ignore', out, out] });
  children.push({ tag, child });
  console.log(`[e2e] started ${tag} (pid ${child.pid}, logs: ${logPath})`);
}

/** Fail fast with a clear message if a previous run still owns a port. */
async function assertPortFree(port) {
  const free = await new Promise((resolve) => {
    const probe = net.connect({ port, host: '127.0.0.1' });
    probe.on('connect', () => {
      probe.destroy();
      resolve(false);
    });
    probe.on('error', () => resolve(true));
  });
  if (!free) {
    throw new Error(
      `port ${port} is already in use — stop the stale process (see: netstat -ano | findstr ":${port}") and retry`,
    );
  }
}

async function waitFor(url, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** fetch + timing; returns {status, body, durationMs}. */
async function call(url) {
  const startedAt = Date.now();
  let status = 0;
  let body = null;
  try {
    const res = await fetch(url);
    status = res.status;
    body = await res.json().catch(() => null);
  } catch {
    /* connection issue surfaces as status 0 */
  }
  return { status, body, durationMs: Date.now() - startedAt };
}

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function circuitOf(serviceName) {
  const { body } = await call(`${GATEWAY}/api/services`);
  const entry = body.services.find((svc) => svc.name === serviceName);
  return entry ? entry.circuit : null;
}

/** Simulator control endpoints may still be warming — retry briefly. */
async function postWithRetry(url, payload) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      if (res.ok || res.status === 404) return;
      lastError = new Error(`request to ${url} failed: ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(300);
  }
  throw lastError;
}

const configurePayment = (payload) =>
  postWithRetry(`${PAYMENT}/simulation/config`, payload);

/** Full reset (online, no latency, no failures). Empty patches are NOT resets. */
const resetPayment = () => postWithRetry(`${PAYMENT}/simulation/reset`);

async function main() {
  console.log('== Step 6 E2E: circuit breaker (payment subject) ==');
  LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-circuit-'));
  console.log(`[boot] child logs: ${LOG_DIR}\n[boot] pre-flight port check…`);
  for (const port of [4000, 4101, 4102, 4103]) await assertPortFree(port);

  console.log('[boot] starting simulators + gateway…');
  for (const [, entry] of SIMULATORS) {
    start(entry.split('/')[0], SERVICES_ROOT, ['--import', 'tsx', entry]);
  }
  start('gateway', BACKEND_ROOT, ['--import', 'tsx', 'src/server.ts']);

  for (const port of [4101, 4102, 4103]) {
    await waitFor(`http://localhost:${port}/health`, `simulator :${port}`);
  }
  await waitFor(`${GATEWAY}/health`, 'gateway');

  // A process that answered health then died = silent port collision etc.
  for (const { tag, child } of children) {
    if (child.exitCode !== null) {
      throw new Error(`${tag} exited during boot (code ${child.exitCode}) — see ${LOG_DIR}/${tag}.log`);
    }
  }
  console.log('[boot] all processes healthy\n');

  // ── T1: Normal — healthy payment service, circuit CLOSED ──────────────────
  console.log('T1: normal traffic on healthy payment service');
  await resetPayment();
  const t1 = await call(`${GATEWAY}/api/payment/test`);
  check('request succeeds', t1.status === 200, `status=${t1.status}`);
  check('no failover metadata noise', t1.body?.failover?.occurred === false,
    JSON.stringify(t1.body?.failover));
  const c1 = await circuitOf('payment');
  check('payment circuit CLOSED', c1.state === 'CLOSED', JSON.stringify(c1));

  // ── T2: Repeated failures trip the circuit ────────────────────────────────
  console.log('\nT2: five consecutive failing logical requests (503)');
  await configurePayment({ failureRate: 100, failureStatus: 503 });
  let lastSlowMs = 0;
  for (let i = 1; i <= 5; i++) {
    const r = await call(`${GATEWAY}/api/payment/test`);
    lastSlowMs = r.durationMs;
    check(
      `failing request #${i} proxied to upstream`,
      r.status === 503 && r.body?.error?.code === 'UPSTREAM_UNAVAILABLE',
      `status=${r.status} code=${r.body?.error?.code} ${r.durationMs}ms`,
    );
  }
  const c2 = await circuitOf('payment');
  check('payment circuit OPEN after threshold', c2.state === 'OPEN', JSON.stringify(c2));
  check('failure count reached threshold', c2.failureCount === 5, `count=${c2.failureCount}`);

  // ── T3: Fail fast while OPEN ──────────────────────────────────────────────
  console.log('\nT3: fail-fast while OPEN');
  const t3 = await call(`${GATEWAY}/api/payment/test`);
  check('rejected with 503 CIRCUIT_OPEN', t3.status === 503 && t3.body?.error?.code === 'CIRCUIT_OPEN',
    `status=${t3.status} code=${t3.body?.error?.code}`);
  check('returned almost instantly (<50ms)', t3.durationMs < 50,
    `${t3.durationMs}ms vs ${lastSlowMs}ms through the retry loop`);
  check('service named in envelope', t3.body?.error?.service === 'payment');

  // ── T4: Recovery — HALF_OPEN probe succeeds -> CLOSED ─────────────────────
  console.log('\nT4: recovery after openDuration elapses (waiting ~11s)');
  await resetPayment(); // heal BEFORE sending the probe
  await sleep(11_000);
  const t4probe = await call(`${GATEWAY}/api/payment/test`);
  check('probe request succeeds', t4probe.status === 200, `status=${t4probe.status} ${t4probe.durationMs}ms`);
  const c4 = await circuitOf('payment');
  check('HALF_OPEN -> CLOSED after successful probe',
    c4.state === 'CLOSED' && c4.failureCount === 0, JSON.stringify(c4));

  // ── T5: Probe fails again -> back to OPEN ─────────────────────────────────
  console.log('\nT5: recovery attempt fails -> HALF_OPEN reopens');
  await configurePayment({ failureRate: 100, failureStatus: 503 });
  for (let i = 1; i <= 5; i++) await call(`${GATEWAY}/api/payment/test`);
  const c5open = await circuitOf('payment');
  check('payment circuit OPEN again', c5open.state === 'OPEN', JSON.stringify(c5open));
  await sleep(11_000);
  const t5probe = await call(`${GATEWAY}/api/payment/test`); // still-failing upstream
  check('probe itself fails (upstream 503)',
    t5probe.status === 503 && t5probe.body?.error?.code !== 'CIRCUIT_OPEN',
    `code=${t5probe.body?.error?.code}`);
  const c5 = await circuitOf('payment');
  check('HALF_OPEN -> OPEN after failed probe', c5.state === 'OPEN', JSON.stringify(c5));

  // ── T6: Isolation — other groups unaffected ───────────────────────────────
  console.log('\nT6: isolation — notification unaffected by payment being OPEN');
  const t6notify = await call(`${GATEWAY}/api/notification/test`);
  check('notification request succeeds', t6notify.status === 200, `status=${t6notify.status}`);
  const notify = await circuitOf('notification');
  const payNow = await circuitOf('payment');
  check('notification circuit CLOSED', notify.state === 'CLOSED', JSON.stringify(notify));
  check('payment circuit still OPEN', payNow.state === 'OPEN', JSON.stringify(payNow));

  console.log(`\n== RESULT: ${passed} passed, ${failed} failed ==`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error('[e2e] fatal:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const { tag, child } of children) {
      console.log(`[e2e] stopping ${tag}`);
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    }
  });
