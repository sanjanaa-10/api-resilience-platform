'use strict';

/**
 * Live end-to-end verification for Step 7 — automatic failover.
 *
 * Zero new dependencies: plain Node (>=20) + global fetch.
 * Spawns FOUR simulators (payment, ai, ai-fallback, notification) plus the
 * gateway, then exercises the ai provider group (ai-primary :4102 +
 * ai-fallback :4104) against a REAL running stack:
 *
 *   T1 primary healthy            -> served directly, no failover
 *   T2 primary offline            -> transparent failover to fallback
 *   T3 primary too slow           -> timeout triggers failover
 *   T4 client error 404           -> NO failover (deterministic errors stay)
 *   T5 circuit OPEN on primary    -> failover WITHOUT contacting primary
 *   T6 both providers down        -> controlled final error, budget stops loops
 *   T7 group isolation            -> payment unaffected by ai-group chaos
 *
 * The gateway child runs with RETRY_MAX_ATTEMPTS=1 so timeout scenarios stay
 * fast (one attempt per provider), and RATE_LIMIT_CAPACITY=1000 so this
 * harness is not itself rate limited.
 *
 * Run from backend/:  node scripts/e2e-failover.cjs
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');

const SERVICES_ROOT = path.resolve(__dirname, '..', '..', 'services');
const BACKEND_ROOT = path.resolve(__dirname, '..');

const GATEWAY = 'http://localhost:4000';
const AI_PRIMARY = 'http://localhost:4102';
const AI_FALLBACK = 'http://localhost:4104';
const AI_GROUP_TEST = `${GATEWAY}/api/ai/test`;

const SIMULATORS = [
  ['payment-service', 'payment-service/src/server.ts'],
  ['ai-service', 'ai-service/src/server.ts'],
  ['ai-fallback-service', 'ai-fallback-service/src/server.ts'],
  ['notification-service', 'notification-service/src/server.ts'],
];

const children = [];
let passed = 0;
let failed = 0;
let LOG_DIR = '';

function start(tag, cwd, args, extraEnv = {}) {
  const logPath = path.join(LOG_DIR, `${tag}.log`);
  const out = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', out, out],
  });
  children.push({ tag, child });
  console.log(`[e2e] started ${tag} (pid ${child.pid}, logs: ${logPath})`);
}

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

const configurePrimary = (payload) => postWithRetry(`${AI_PRIMARY}/simulation/config`, payload);
const resetPrimary = () => postWithRetry(`${AI_PRIMARY}/simulation/reset`);
const configureFallback = (payload) =>
  postWithRetry(`${AI_FALLBACK}/simulation/config`, payload);

/** Lifetime counter from GET /simulation/state — hard proof of contact. */
async function requestsHandled(base) {
  const { body } = await call(`${base}/simulation/state`);
  return body?.stats?.requestsHandled ?? -1;
}

async function circuitOf(serviceName) {
  const { body } = await call(`${GATEWAY}/api/services`);
  const entry = body.services.find((svc) => svc.name === serviceName);
  return entry ? entry.circuit : null;
}

async function main() {
  console.log('== Step 7 E2E: automatic failover ==');
  LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-failover-'));
  console.log(`[boot] child logs: ${LOG_DIR}\n[boot] pre-flight port check…`);
  for (const port of [4000, 4101, 4102, 4103, 4104]) await assertPortFree(port);

  console.log('[boot] starting simulators + gateway…');
  for (const [, entry] of SIMULATORS) {
    start(entry.split('/')[0], SERVICES_ROOT, ['--import', 'tsx', entry]);
  }
  start('gateway', BACKEND_ROOT, ['--import', 'tsx', 'src/server.ts'], {
    RETRY_MAX_ATTEMPTS: '1',
    RATE_LIMIT_CAPACITY: '1000',
  });

  for (const port of [4101, 4102, 4103, 4104]) {
    await waitFor(`http://localhost:${port}/health`, `simulator :${port}`);
  }
  await waitFor(`${GATEWAY}/health`, 'gateway');

  for (const { tag, child } of children) {
    if (child.exitCode !== null) {
      throw new Error(`${tag} exited during boot (code ${child.exitCode}) — see ${LOG_DIR}/${tag}.log`);
    }
  }
  // Let one health round complete so the fallback health gate is meaningful.
  await sleep(1500);
  console.log('[boot] all processes healthy\n');

  // ── T1: Primary healthy -> direct hit, no failover ────────────────────────
  console.log('T1: primary healthy — request served directly');
  let t1 = await call(AI_GROUP_TEST);
  if (t1.status !== 200) t1 = await call(AI_GROUP_TEST); // first hit may race boot probing
  check('200 OK', t1.status === 200, `status=${t1.status}`);
  check('served by PRIMARY', t1.body?.failover?.selectedProvider === 'ai-primary',
    JSON.stringify(t1.body?.failover));
  check('failover NOT occurred', t1.body?.failover?.occurred === false);
  check('payload has no fallback model id',
    typeof t1.body?.data?.model === 'string' && !t1.body.data.model.endsWith('-fallback'),
    `model=${t1.body?.data?.model}`);

  // ── T2: Primary offline -> transparent failover ───────────────────────────
  console.log('\nT2: primary offline — transparent failover to ai-fallback');
  await configurePrimary({ online: false });
  const t2 = await call(AI_GROUP_TEST);
  check('still 200 OK (client sees success)', t2.status === 200, `status=${t2.status}`);
  check('failover occurred', t2.body?.failover?.occurred === true, JSON.stringify(t2.body?.failover));
  check('selectedProvider = ai-fallback', t2.body?.failover?.selectedProvider === 'ai-fallback');
  check('primary recorded as ai-primary', t2.body?.failover?.primary === 'ai-primary');
  // Simulated "offline" is a CONTROLLED 503 (SIMULATED_OFFLINE), so the
  // truthful failover reason here is HTTP_503. True network-level refusals
  // (process dead) map to NETWORK_UNAVAILABLE — covered by unit tests.
  check('reason HTTP_503', t2.body?.failover?.reason === 'HTTP_503');
  check('fallback payload served (model id)', String(t2.body?.data?.model ?? '').endsWith('-fallback'),
    `model=${t2.body?.data?.model}`);
  await resetPrimary();

  // ── T3: Primary too slow (timeout > gateway deadline) -> failover ─────────
  console.log('\nT3: primary latency 4000ms > 3000ms deadline — timeout triggers failover');
  await configurePrimary({ latencyMs: 4000 });
  const t3 = await call(AI_GROUP_TEST);
  check('still 200 OK via fallback', t3.status === 200 && t3.body?.failover?.occurred === true,
    `status=${t3.status} failover=${JSON.stringify(t3.body?.failover)}`);
  check('reason UPSTREAM_TIMEOUT', t3.body?.failover?.reason === 'UPSTREAM_TIMEOUT',
    JSON.stringify(t3.body?.failover));
  check('wall-clock bounded (~4s, not 8s+): single fallback attempt after timeout',
    t3.durationMs >= 3500 && t3.durationMs < 9000, `${t3.durationMs}ms`);
  await resetPrimary();

  // ── T4: Client error 404 — deterministic failures NEVER fail over ─────────
  console.log('\nT4: primary returns 404 — passthrough, NO failover attempted');
  await configurePrimary({ latencyMs: 50, failureRate: 100, failureStatus: 404 });
  const fallbackBefore = await requestsHandled(AI_FALLBACK);
  const t4 = await call(AI_GROUP_TEST);
  const fallbackAfter = await requestsHandled(AI_FALLBACK);
  check('404 passed through unchanged', t4.status === 404 && t4.body?.error?.code === 'UPSTREAM_ERROR',
    `status=${t4.status} code=${t4.body?.error?.code}`);
  check('envelope names ai-primary as the failing service',
    t4.body?.error?.service === 'ai-primary', `service=${t4.body?.error?.service}`);
  check('no failover context in error envelope',
    t4.body?.error?.upstream?.failover === undefined);
  check('fallback received ZERO requests during this call',
    fallbackAfter === fallbackBefore, `before=${fallbackBefore} after=${fallbackAfter}`);
  check('returned fast (<500ms — no fallback detour)', t4.durationMs < 500, `${t4.durationMs}ms`);
  await resetPrimary();

  // ── T5: Circuit OPEN on primary -> instant reroute, zero primary contact ──
  console.log('\nT5: five failing-over requests trip ai-primary; next request skips it entirely');
  await configurePrimary({ online: false }); // connection refusals are CB failures
  for (let i = 1; i <= 5; i++) {
    const r = await call(AI_GROUP_TEST);
    check(`failing-over request #${i} still succeeds via fallback`, r.status === 200,
      `status=${r.status}`);
  }
  const c5primary = await circuitOf('ai-primary');
  const c5fallback = await circuitOf('ai-fallback');
  check('ai-primary circuit OPEN (threshold reached)', c5primary.state === 'OPEN', JSON.stringify(c5primary));
  check('failure count exactly 5 (one outcome per logical request)',
    c5primary.failureCount === 5, `count=${c5primary.failureCount}`);
  check('ai-fallback circuit CLOSED throughout', c5fallback.state === 'CLOSED', JSON.stringify(c5fallback));

  const t5open = await call(AI_GROUP_TEST);
  check('request while OPEN still succeeds (fallback serves)', t5open.status === 200,
    `status=${t5open.status}`);
  check('failover reason CIRCUIT_OPEN (admission rejected before any contact)',
    t5open.body?.failover?.reason === 'CIRCUIT_OPEN', JSON.stringify(t5open.body?.failover));
  check('fast (<1200ms ≈ fallback latency only)', t5open.durationMs < 1200, `${t5open.durationMs}ms`);
  const c5after = await circuitOf('ai-primary');
  check('rejection recorded NOTHING against the open circuit',
    c5after.failureCount === 5, `count=${c5after.failureCount}`);

  // ── T6: Both providers down -> controlled error, budget forbids loops ─────
  console.log('\nT6: both providers down — controlled final error, no retry storm');
  await configureFallback({ online: false });
  const t6 = await call(AI_GROUP_TEST);
  check('controlled 503 (never a hang/crash)', t6.status === 503, `status=${t6.status}`);
  check('deterministic envelope code',
    ['CIRCUIT_OPEN', 'UPSTREAM_UNAVAILABLE'].includes(t6.body?.error?.code),
    `code=${t6.body?.error?.code}`);
  check('terminated fast (<3000ms — at most ONE fallback attempt)',
    t6.durationMs < 3000, `${t6.durationMs}ms`);

  // ── T7: Isolation — payment group oblivious to ai-group chaos ─────────────
  console.log('\nT7: isolation — payment unaffected while ai-primary is OPEN and fallback down');
  const t7 = await call(`${GATEWAY}/api/payment/test`);
  check('payment still 200 OK', t7.status === 200, `status=${t7.status}`);
  const payCircuit = await circuitOf('payment');
  check('payment circuit CLOSED', payCircuit.state === 'CLOSED', JSON.stringify(payCircuit));
  const primaryStillOpen = await circuitOf('ai-primary');
  check('ai-primary circuit still OPEN', primaryStillOpen.state === 'OPEN');

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
