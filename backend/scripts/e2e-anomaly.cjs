'use strict';

/**
 * Live end-to-end verification for Step 9 - explainable anomaly detection.
 *
 * Zero new dependencies: plain Node (>=20) + global fetch.
 * Spawns FOUR simulators plus the gateway, then proves on a REAL stack:
 *
 *   A meta surface        -> version 0.9.0 advertises /api/anomalies
 *   B cold start -> normal-> INSUFFICIENT_DATA until minSamples, then NORMAL
 *                            with score ~0 and NO fabricated explanations
 *   C latency chaos       -> injected 2500ms upstream latency (below the 3s
 *                            timeout!) drives payment to WARNING/ANOMALOUS
 *                            WITH an explanation naming the latency metric,
 *                            an ANOMALY_DETECTED event, and traffic still 200
 *   D isolation           -> ai-primary stays NORMAL while payment degrades
 *   E recovery            -> after reset, payment returns to NORMAL and an
 *                            ANOMALY_RESOLVED event is stored
 *   F read-API hygiene    -> collection shape, history endpoint, 404s
 *
 * Gateway child runs with FAST detection tuning (500ms sampling, minSamples 4,
 * window 16) so the whole story completes in well under a minute.
 *
 * Run from backend/:  node scripts/e2e-anomaly.cjs
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');

const SERVICES_ROOT = path.resolve(__dirname, '..', '..', 'services');
const BACKEND_ROOT = path.resolve(__dirname, '..');

const GATEWAY = 'http://localhost:4000';
const PAYMENT_SIM = 'http://localhost:4101';
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
      `port ${port} is already in use - stop the stale process (see: netstat -ano | findstr ":${port}") and retry`,
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
  let status = 0;
  let body = null;
  try {
    const res = await fetch(url);
    status = res.status;
    body = await res.json().catch(() => null);
  } catch {
    /* connection issue surfaces as status 0 */
  }
  return { status, body };
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.status;
}

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}${detail ? ` -- ${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

async function burst(url, n, results) {
  const jobs = Array.from({ length: n }, async () => {
    const r = await call(url);
    if (results) results.push(r.status);
    return r;
  });
  return Promise.all(jobs);
}

const configurePayment = (payload) => postJson(`${PAYMENT_SIM}/simulation/config`, payload);
const resetPayment = () => postJson(`${PAYMENT_SIM}/simulation/reset`, {});

const anomaliesUrl = (route) => `${GATEWAY}/api/anomalies${route}`;
async function reportOf(service) {
  const { status, body } = await call(anomaliesUrl(`/${service}`));
  return { status, report: body };
}
async function listAnomalies() {
  const { body } = await call(anomaliesUrl(''));
  return body?.anomalies ?? [];
}
async function listEvents(query) {
  const params = new URLSearchParams(Object.entries(query));
  const { body } = await call(`${GATEWAY}/api/events?${params.toString()}`);
  return body?.events ?? [];
}

/** Poll until `predicate` holds or the deadline passes; returns last value. */
async function eventually(fn, predicate, timeoutMs = 8000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await fn();
    if (predicate(value)) return value;
    await sleep(300);
  }
  console.error(`  WARN eventually() gave up waiting for ${label}`);
  return value;
}

async function main() {
  console.log('== Step 9 E2E: explainable anomaly detection ==');
  LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-anomaly-'));
  console.log(`[boot] child logs: ${LOG_DIR}\n[boot] pre-flight port check...`);
  for (const port of [4000, 4101, 4102, 4103, 4104]) await assertPortFree(port);

  console.log('[boot] starting simulators + gateway...');
  for (const [, entry] of SIMULATORS) {
    start(entry.split('/')[0], SERVICES_ROOT, ['--import', 'tsx', entry]);
  }
  start('gateway', BACKEND_ROOT, ['--import', 'tsx', 'src/server.ts'], {
    RETRY_MAX_ATTEMPTS: '3',
    RETRY_BASE_DELAY_MS: '50',
    RETRY_MAX_DELAY_MS: '200',
    RATE_LIMIT_CAPACITY: '1000',
    UPSTREAM_TIMEOUT_MS: '3000',
    ANOMALY_SAMPLE_INTERVAL_MS: '500',
    ANOMALY_WINDOW_SIZE: '16',
    ANOMALY_MIN_SAMPLES: '4',
  });

  for (const port of [4101, 4102, 4103, 4104]) {
    await waitFor(`http://localhost:${port}/health`, `simulator :${port}`);
  }
  await waitFor(`${GATEWAY}/health`, 'gateway');

  for (const { tag, child } of children) {
    if (child.exitCode !== null) {
      throw new Error(`${tag} exited during boot (code ${child.exitCode}) -- see ${LOG_DIR}/${tag}.log`);
    }
  }
  await sleep(1200);
  console.log('[boot] all processes healthy\n');

  // ---- A: meta surface -------------------------------------------------------
  console.log('A: meta advertises anomaly endpoints');
  const meta = await call(GATEWAY + '/');
  check('meta version 0.9.0', meta.body?.version === '0.9.0', `version=${meta.body?.version}`);
  check('meta advertises /api/anomalies', meta.body?.endpoints?.anomalies === '/api/anomalies');

  // One request creates the FIRST observation once the next sampling tick
  // runs; until minSamples (4) volume ticks occur, the service must report
  // INSUFFICIENT_DATA with NO score.
  await call(PAYMENT_TEST);
  const coldStart = await eventually(
    () => call(anomaliesUrl('/payment')),
    (r) => r.status === 200,
    5_000,
    'first anomaly snapshot to appear',
  );
  check(
    'cold-start status INSUFFICIENT_DATA with null score',
    coldStart.status === 200 &&
      coldStart.body?.status === 'INSUFFICIENT_DATA' &&
      coldStart.body?.score === null,
    `http=${coldStart.status} status=${coldStart.body?.status} score=${coldStart.body?.score}`,
  );

  // ---- B: warm traffic -> NORMAL --------------------------------------------
  console.log('\nB: warm-up traffic -> baselines fill, status becomes NORMAL');
  // One sample is emitted per 500ms tick that sees traffic, so keep a steady
  // trickle going for several seconds to bank well over minSamples samples.
  const warmStatuses = [];
  const warmDeadline = Date.now() + 6_000;
  while (Date.now() < warmDeadline) {
    await Promise.all([
      burst(PAYMENT_TEST, 3, warmStatuses),
      burst(AI_GROUP_TEST, 2, null),
    ]);
    await sleep(350);
  }
  check('warm-up payment requests all 200', warmStatuses.every((s) => s === 200),
    `${warmStatuses.filter((s) => s !== 200).length} non-200`);

  const warmed = await eventually(
    () => reportOf('payment'),
    (r) => r.report?.status === 'NORMAL',
    15_000,
    'payment reaching NORMAL',
  );
  check('payment reaches NORMAL after warm-up', warmed.report?.status === 'NORMAL',
    `status=${warmed.report?.status}`);
  check('sampleCount >= minSamples (4)', (warmed.report?.sampleCount ?? 0) >= 4,
    `samples=${warmed.report?.sampleCount}`);
  check('score below WARNING on healthy traffic', (warmed.report?.score ?? 1) < 0.5,
    `score=${warmed.report?.score}`);
  check('no anomaly reasons on healthy traffic', (warmed.report?.reasons ?? []).length === 0);

  const aiWarm = await eventually(
    () => reportOf('ai-primary'),
    (r) => r.status === 200 && ['NORMAL', 'INSUFFICIENT_DATA'].includes(r.report?.status),
    10_000,
    'ai-primary tracked',
  );
  check('ai-primary tracked with its own baseline', aiWarm.status === 200 &&
    ['NORMAL', 'INSUFFICIENT_DATA'].includes(aiWarm.report?.status),
    `status=${aiWarm.report?.status}`);

  // ---- C: latency chaos on payment -------------------------------------------
  console.log('\nC: inject 2500ms latency into payment (below 3s timeout)');
  check('chaos config accepted', (await configurePayment({ latencyMs: 2500 })) === 200);

  const chaosStatuses = [];
  let degraded = null;
  const chaosDeadline = Date.now() + 40_000;
  while (Date.now() < chaosDeadline) {
    await burst(PAYMENT_TEST, 6, chaosStatuses);
    const r = await reportOf('payment');
    if (['WARNING', 'ANOMALOUS'].includes(r.report?.status)) {
      degraded = r.report;
      break;
    }
    await sleep(400);
  }

  check('traffic KEPT WORKING during degradation (all 200)',
    chaosStatuses.length > 0 && chaosStatuses.every((s) => s === 200),
    `${chaosStatuses.length} requests, ${chaosStatuses.filter((s) => s !== 200).length} non-200`);
  check('payment degrades to WARNING or ANOMALOUS', degraded !== null,
    degraded ? `status=${degraded.status}` : 'never degraded');
  check('score crosses WARNING threshold (0.5)', (degraded?.score ?? 0) >= 0.5,
    `score=${degraded?.score}`);

  const topReason = degraded?.reasons?.[0];
  check('explanation names a latency metric first',
    topReason?.metric === 'p95LatencyMs' || topReason?.metric === 'avgLatencyMs',
    topReason ? `top=${topReason.metric}` : 'no reasons');
  check('explanation carries zScore >= 3 and positive change%',
    (topReason?.zScore ?? 0) >= 3 && (topReason?.changePercent ?? 0) > 0,
    topReason ? `z=${topReason.zScore} change=${topReason.changePercent}%` : 'n/a');
  check('explanation shows current far above baseline',
    (topReason?.current ?? 0) > (topReason?.baseline ?? Infinity),
    topReason ? `current=${topReason.current} vs baseline=${topReason.baseline}` : 'n/a');

  const detectedEvents = await eventually(
    () => listEvents({ type: 'ANOMALY_DETECTED', service: 'payment' }),
    (events) => events.length >= 1,
    8000,
    'ANOMALY_DETECTED event',
  );
  check('ANOMALY_DETECTED event stored', detectedEvents.length >= 1, `n=${detectedEvents.length}`);
  const detMeta = detectedEvents[0]?.metadata ?? {};
  check('event metadata explains status/score/reasons',
    typeof detMeta.score === 'number' && Array.isArray(detMeta.reasons) && detMeta.reasons.length >= 1,
    `score=${detMeta.score} reasons=${detMeta.reasons?.length}`);

  // ---- D: isolation -----------------------------------------------------------
  console.log('\nD: isolation - ai-primary unaffected by payment chaos');
  const aiDuringChaos = await reportOf('ai-primary');
  check('ai-primary NOT anomalous during payment incident',
    aiDuringChaos.status === 200 && !['WARNING', 'ANOMALOUS'].includes(aiDuringChaos.report?.status),
    `status=${aiDuringChaos.report?.status}`);

  // ---- E: recovery --------------------------------------------------------------
  console.log('\nE: reset payment -> back to NORMAL + resolution event');
  check('reset accepted', (await resetPayment()) === 200);

  const recovered = await eventually(
    async () => {
      await burst(PAYMENT_TEST, 3, null);
      return reportOf('payment');
    },
    (r) => r.report?.status === 'NORMAL',
    45_000,
    'payment returning to NORMAL',
  );
  check('payment returns to NORMAL', recovered.report?.status === 'NORMAL',
    `status=${recovered.report?.status} score=${recovered.report?.score}`);

  const resolvedEvents = await eventually(
    () => listEvents({ type: 'ANOMALY_RESOLVED', service: 'payment' }),
    (events) => events.length >= 1,
    8000,
    'ANOMALY_RESOLVED event',
  );
  check('ANOMALY_RESOLVED event stored', resolvedEvents.length >= 1, `n=${resolvedEvents.length}`);

  // ---- F: read-API hygiene -------------------------------------------------------
  console.log('\nF: collection shape, history, 404s');
  const all = await listAnomalies();
  check('collection lists both tracked services',
    all.some((a) => a.service === 'payment') && all.some((a) => a.service === 'ai-primary'),
    `services=${all.map((a) => a.service).join(',')}`);

  const history = await call(anomaliesUrl('/payment/history'));
  check('history endpoint returns bounded entries',
    history.status === 200 && (history.body?.count ?? 0) >= 3,
    `entries=${history.body?.count}`);
  const stamps = (history.body?.history ?? []).map((h) => h.timestamp);
  check('history timestamps ascend',
    stamps.every((t, i) => i === 0 || t >= stamps[i - 1]));

  const unknownService = await call(anomaliesUrl('/definitely-not-a-service'));
  check('unknown service report -> 404', unknownService.status === 404);
  const unknownHistory = await call(anomaliesUrl('/definitely-not-a-service/history'));
  check('unknown service history -> 404', unknownHistory.status === 404);

  // ---- wrap up --------------------------------------------------------------------
  console.log(`\n== RESULTS: ${passed} passed, ${failed} failed ==`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`[e2e] FATAL: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const { tag, child } of children) {
      try {
        child.kill();
        console.log(`[e2e] stopped ${tag}`);
      } catch {
        /* already gone */
      }
    }
  });
