'use strict';

/**
 * Live end-to-end verification for Step 8 â€” observability + incident timeline.
 *
 * Zero new dependencies: plain Node (>=20) + global fetch.
 * Spawns FOUR simulators plus the gateway, then proves on a REAL stack:
 *
 *   A normal traffic      -> /api/metrics counters + latency stats populated,
 *                            REQUEST_* events stored, meta advertises endpoints
 *   B retries             -> RETRY_ATTEMPT events + retryCount metrics
 *   C circuit opens       -> CIRCUIT_OPENED event, ACTIVE CRITICAL incident
 *   D failover            -> FAILOVER_STARTED/COMPLETED events, failover flag
 *   E timeline            -> chronological buildup incl. pre-incident signals
 *   F resolution          -> circuit closes -> incident RESOLVED w/ endedAt
 *   + read-API hygiene    -> invalid query 400, unknown incident 404
 *
 * Gateway child runs with a SHORT circuit cool-off (3s) and quiet period (2s)
 * so scenario F completes quickly; retries enabled (3 attempts, tiny backoff)
 * so scenario B produces real retry events.
 *
 * Run from backend/:  node scripts/e2e-observability.cjs
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
const PAYMENT_TEST = `${GATEWAY}/api/payment/test`;
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
      `port ${port} is already in use â€” stop the stale process (see: netstat -ano | findstr ":${port}") and retry`,
    );
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    console.log(`  PASS ${name}${detail ? ` â€” ${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` â€” ${detail}` : ''}`);
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

const obsUrl = (route) => `${GATEWAY}/api${route}`;
async function listEvents(query) {
  const params = new URLSearchParams(
    Object.entries(query).filter(([, value]) => value !== undefined),
  );
  const { body } = await call(`${obsUrl('/events')}?${params.toString()}`);
  return body?.events ?? [];
}
async function metricsSnapshot() {
  const { body } = await call(obsUrl('/metrics'));
  return body;
}
async function activeIncidents() {
  const { body } = await call(obsUrl('/incidents/active'));
  return body?.incidents ?? [];
}
async function getIncident(id) {
  const { body } = await call(obsUrl(`/incidents/${id}`));
  return body;
}

/** Poll until `predicate` holds or the deadline passes; returns last value. */
async function eventually(fn, predicate, timeoutMs = 8000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await fn();
    if (predicate(value)) return value;
    await sleep(250);
  }
  console.error(`  WARN eventually() gave up waiting for ${label}`);
  return value;
}

async function main() {
  console.log('== Step 8 E2E: observability + incident timeline ==');
  LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-observability-'));
  console.log(`[boot] child logs: ${LOG_DIR}\n[boot] pre-flight port checkâ€¦`);
  for (const port of [4000, 4101, 4102, 4103, 4104]) await assertPortFree(port);

  console.log('[boot] starting simulators + gatewayâ€¦');
  for (const [, entry] of SIMULATORS) {
    start(entry.split('/')[0], SERVICES_ROOT, ['--import', 'tsx', entry]);
  }
  start('gateway', BACKEND_ROOT, ['--import', 'tsx', 'src/server.ts'], {
    RETRY_MAX_ATTEMPTS: '3',
    RETRY_BASE_DELAY_MS: '50',
    RETRY_MAX_DELAY_MS: '200',
    RATE_LIMIT_CAPACITY: '1000',
    CIRCUIT_BREAKER_OPEN_DURATION_MS: '3000',
    INCIDENT_RECOVERY_QUIET_MS: '2000',
  });

  for (const port of [4101, 4102, 4103, 4104]) {
    await waitFor(`http://localhost:${port}/health`, `simulator :${port}`);
  }
  await waitFor(`${GATEWAY}/health`, 'gateway');

  for (const { tag, child } of children) {
    if (child.exitCode !== null) {
      throw new Error(`${tag} exited during boot (code ${child.exitCode}) â€” see ${LOG_DIR}/${tag}.log`);
    }
  }
  await sleep(1200);
  console.log('[boot] all processes healthy\n');

  // â”€â”€ A: normal traffic populates metrics + lifecycle events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log('A: normal request â€” metrics, events, meta surface');
  const meta = await call(GATEWAY + '/');
  check('meta version 0.9.0', meta.body?.version === '0.9.0', `version=${meta.body?.version}`);
  check('meta advertises observability endpoints',
    meta.body?.endpoints?.metrics === '/api/metrics' &&
    meta.body?.endpoints?.events === '/api/events' &&
    meta.body?.endpoints?.incidents === '/api/incidents');

  const a = await call(PAYMENT_TEST);
  check('payment 200 OK', a.status === 200, `status=${a.status}`);

  const snapA = await eventually(metricsSnapshot, (m) => (m?.services?.payment?.successCount ?? 0) >= 1, 6000, 'payment success metric');
  check('totals.requestCount >= 1', (snapA?.totals?.requestCount ?? 0) >= 1, `count=${snapA?.totals?.requestCount}`);
  check('payment successCount >= 1', (snapA?.services?.payment?.successCount ?? 0) >= 1);
  check('payment averageLatencyMs populated', typeof snapA?.services?.payment?.averageLatencyMs === 'number',
    `avg=${snapA?.services?.payment?.averageLatencyMs}ms`);
  check('payment p95LatencyMs populated', typeof snapA?.services?.payment?.p95LatencyMs === 'number',
    `p95=${snapA?.services?.payment?.p95LatencyMs}ms`);

  const completed = await listEvents({ type: 'REQUEST_COMPLETED', service: 'payment' });
  check('REQUEST_COMPLETED event stored for payment', completed.length >= 1, `n=${completed.length}`);
  check('terminal event carries duration + group metadata',
    typeof completed[0]?.metadata?.durationMs === 'number' && completed[0]?.metadata?.group === 'payment');
  const started = await listEvents({ type: 'REQUEST_STARTED' });
  check('REQUEST_STARTED event stored', started.length >= 1, `n=${started.length}`);

  // Read-API hygiene.
  const bogusType = await call(`${obsUrl('/events')}?type=NOT_A_TYPE`);
  check('invalid event type -> 400 envelope', bogusType.status === 400 && bogusType.body?.error?.statusCode === 400);
  const badLimit = await call(`${obsUrl('/events')}?limit=-5`);
  check('invalid limit -> 400', badLimit.status === 400);
  const missingIncident = await call(obsUrl('/incidents/nope-123'));
  check('unknown incident id -> 404', missingIncident.status === 404);

  // â”€â”€ B: retries produce real-time RETRY_ATTEMPT events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log('\nB: 60% transient 503s â€” retry events + retry metrics');
  await configurePrimary({ failureRate: 60, failureStatus: 503 });
  let sawRetry = false;
  let sawRetryMetric = false;
  for (let i = 0; i < 12; i++) {
    await call(AI_GROUP_TEST);
    const retries = await listEvents({ type: 'RETRY_ATTEMPT', service: 'ai-primary' });
    if (retries.length > 0) sawRetry = true;
    const m = await metricsSnapshot();
    if ((m?.totals?.retryCount ?? 0) > 0) sawRetryMetric = true;
    if (sawRetry && sawRetryMetric) break;
  }
  check('RETRY_ATTEMPT events recorded for ai-primary', sawRetry);
  check('metrics.totals.retryCount incremented', sawRetryMetric);
  await resetPrimary();

  // â”€â”€ C+D: take the primary down â€” circuit opens, incident starts, failover â”€
  console.log('\nC+D: primary down â€” failover storm trips circuit, incident opens');
  await configurePrimary({ online: false });
  for (let i = 0; i < 7; i++) {
    const r = await call(AI_GROUP_TEST);
    check(`failing-over request #${i + 1} still succeeds`, r.status === 200, `status=${r.status}`);
    if (r.status !== 200) break;
  }

  const openedEvents = await listEvents({ type: 'CIRCUIT_OPENED', service: 'ai-primary' });
  check('CIRCUIT_OPENED event recorded', openedEvents.length >= 1, `n=${openedEvents.length}`);

  const foStarted = await listEvents({ type: 'FAILOVER_STARTED', service: 'ai-primary' });
  const foCompleted = await listEvents({ type: 'FAILOVER_COMPLETED', service: 'ai-primary' });
  check('FAILOVER_STARTED events recorded', foStarted.length >= 1, `n=${foStarted.length}`);
  check('FAILOVER_COMPLETED events recorded', foCompleted.length >= 1, `n=${foCompleted.length}`);

  const snapC = await metricsSnapshot();
  check('metrics.totals.failoverCount >= 1', (snapC?.totals?.failoverCount ?? 0) >= 1,
    `failovers=${snapC?.totals?.failoverCount}`);
  check('metrics.totals.circuitOpenCount >= 1', (snapC?.totals?.circuitOpenCount ?? 0) >= 1);
  check('ai-fallback successCount >= 1 (it served the traffic)',
    (snapC?.services?.['ai-fallback']?.successCount ?? 0) >= 1);

  const incidents = await eventually(activeIncidents, (list) =>
    list.some((incident) => incident.service === 'ai-primary'), 6000, 'ai-primary incident');
  const incident = incidents.find((entry) => entry.service === 'ai-primary');
  check('ACTIVE incident exists for ai-primary', incident !== undefined);
  check('incident severity escalated to CRITICAL', incident?.severity === 'CRITICAL',
    incident?.severity);
  check('incident flags: circuitOpened + failoverOccurred',
    incident?.circuitOpened === true && incident?.failoverOccurred === true);
  check('affectedRequests counts distinct failing requests', (incident?.affectedRequests ?? 0) >= 1,
    `n=${incident?.affectedRequests}`);

  // â”€â”€ E: timeline tells the chronological story â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log('\nE: incident timeline â€” buildup precedes the circuit trip');
  const detail = incident ? await getIncident(incident.incidentId) : null;
  check('GET /incidents/:id returns the full incident', detail?.incidentId === incident?.incidentId);
  const timeline = detail?.timeline ?? [];
  check('timeline has multiple entries', timeline.length >= 4, `entries=${timeline.length}`);
  const times = timeline.map((entry) => Date.parse(entry.timestamp));
  check('timeline strictly chronological (non-decreasing)',
    times.every((t, i) => i === 0 || t >= times[i - 1]));
  const firstFailoverIdx = timeline.findIndex((e) => e.eventType === 'FAILOVER_STARTED');
  const circuitIdx = timeline.findIndex((e) => e.eventType === 'CIRCUIT_OPENED');
  check('failover buildup BEFORE circuit opening',
    firstFailoverIdx !== -1 && circuitIdx !== -1 && firstFailoverIdx < circuitIdx,
    `failover@${firstFailoverIdx} circuit@${circuitIdx}`);
  check('a FAILOVER_COMPLETED follows the first STARTED',
    timeline.findIndex((e, idx) => idx > firstFailoverIdx && e.eventType === 'FAILOVER_COMPLETED') > firstFailoverIdx);
  check('every timeline entry has required fields',
    timeline.every((e) =>
      typeof e.timestamp === 'string' &&
      typeof e.eventType === 'string' &&
      typeof e.severity === 'string' &&
      typeof e.message === 'string'));
  check('summary reflects circuit + failover facts',
    /circuit OPENED/.test(detail?.summary ?? '') && /traffic failed over/.test(detail?.summary ?? ''),
    detail?.summary);

  // â”€â”€ F: recovery â€” circuit closes, incident resolves â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log('\nF: recovery â€” cool-off elapses, probe closes circuit, incident resolves');
  await resetPrimary();
  await sleep(3400); // CIRCUIT_BREAKER_OPEN_DURATION_MS = 3000
  const f = await call(AI_GROUP_TEST);
  check('post-recovery request 200 OK served by PRIMARY again',
    f.status === 200 && f.body?.failover?.selectedProvider === 'ai-primary',
    `status=${f.status} selected=${f.body?.failover?.selectedProvider}`);

  const resolvedView = await eventually(
    () => getIncident(incident.incidentId),
    (inc) => inc?.status === 'RESOLVED',
    8000,
    'incident resolution',
  );
  check('incident transitioned to RESOLVED', resolvedView?.status === 'RESOLVED',
    resolvedView?.status);
  check('endedAt stamped', typeof resolvedView?.endedAt === 'string');
  // Two deterministic exit conditions exist: the explicit CIRCUIT_CLOSED
  // signal, or the passive quiet period (whichever fires first â€” during the
  // cool-off sleep the health flip usually satisfies the latter first).
  check('resolution reason recorded in summary',
    /Resolved \((circuit closed|quiet period elapsed without failures)\)/.test(resolvedView?.summary ?? ''),
    resolvedView?.summary);
  check('active list is now empty for ai-primary',
    !(await activeIncidents()).some((entry) => entry.service === 'ai-primary'));

  const halfOpen = await listEvents({ type: 'CIRCUIT_HALF_OPEN', service: 'ai-primary' });
  const closed = await listEvents({ type: 'CIRCUIT_CLOSED', service: 'ai-primary' });
  check('HALF_OPEN + CLOSED transitions observable in the stream',
    halfOpen.length >= 1 && closed.length >= 1, `half=${halfOpen.length} closed=${closed.length}`);

  // Final sanity: bounded store respected (capacity far above our volume).
  const finalSnap = await metricsSnapshot();
  check('final snapshot well-formed', typeof finalSnap?.generatedAt === 'string' &&
    finalSnap?.totals !== undefined && finalSnap?.services !== undefined);

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
