# Simulated Upstream Services

Four realistic **unreliable external dependencies** used to test the API
Resilience & Failover Platform gateway. Each behaves like a real third-party
API with controllable latency, failure rate and availability.

They are intentionally fake-but-honest: every failure is clearly labeled as a
simulation in logs and payloads, while behaving exactly like real chaos from
the caller's perspective.

| Service                | Port | Business endpoint            | Default latency |
| ---------------------- | ---- | ---------------------------- | --------------- |
| `payment-service`      | 4101 | `GET /api/payments/test`     | 120 ms          |
| `ai-service`           | 4102 | `GET /api/ai/test`           | 800 ms          |
| `ai-fallback-service`  | 4104 | `GET /api/ai/test`           | 800 ms          |
| `notification-service` | 4103 | `GET /api/notifications/test`| 250 ms          |

`ai-service` (gateway-side name `ai-primary`) and `ai-fallback-service`
(`ai-fallback`) form the gateway's **ai failover group**: same endpoint
contract, distinguishable payload (`model` ids ending in `-fallback`).

All four share one implementation (`shared/`) — each service is only an
identity + domain payload definition composed onto a common factory.

---

## Quick start

```bash
cd services
npm install

npm run dev                 # all four services, one terminal (Ctrl+C stops all)
# or individually:
npm run dev:payment         # tsx watch on :4101
npm run dev:ai              # tsx watch on :4102
npm run dev:ai-fallback     # tsx watch on :4104
npm run dev:notification    # tsx watch on :4103
```

Production-style run:

```bash
npm run build               # compiles everything to dist/
npm run start:payment       # node dist/... — repeat per service, 4 terminals
```

> Windows note: if this project lives under a path containing `&`, npm `.bin`
> shims break — all scripts therefore invoke tools through `node` directly.

## Endpoints (identical surface on all four services)

### `GET /health`

Liveness probe. Reports `unhealthy` while simulation is switched offline so
future gateway health checks react to chaos commands.

```json
{
  "service": "payment-service",
  "status": "healthy",
  "latencyMs": 120,
  "timestamp": "2026-08-23T23:08:25.515Z"
}
```

### Business endpoint (e.g. `GET /api/ai/test`)

Success:

```json
{
  "service": "ai-service",
  "requestId": "50f01fdf-...",
  "timestamp": "2026-08-23T23:08:26.378Z",
  "simulatedLatencyMs": 800,
  "status": "success",
  "data": { "...domain payload..." : "" }
}
```

Simulated failure (`failureRate` hit) → HTTP 500:

```json
{
  "service": "ai-service",
  "requestId": "31208c75-...",
  "status": "error",
  "error": { "code": "SIMULATED_FAILURE", "message": "ai-service failed while processing the request (simulated)." }
}
```

Offline → HTTP 503 with `"code": "SIMULATED_OFFLINE"` (fast-fail, ~0 ms).

## Simulation controls

| Endpoint                   | Method | Purpose                                    |
| -------------------------- | ------ | ------------------------------------------ |
| `/simulation/state`        | GET    | Current knobs + lifetime counters           |
| `/simulation/config`       | POST   | Partial update of `{online, latencyMs, failureRate}` |
| `/simulation/reset`        | POST   | Restore defaults, zero counters             |

Behavior rules applied in order:

1. `online=false` → immediate `503`.
2. `latencyMs > 0` → response delayed by that amount (non-blocking).
3. random roll within `failureRate`% → controlled `500`.
4. otherwise → success + domain payload.

Validation (never crashes the server):

- `online`: boolean
- `latencyMs`: integer, `0..60000`
- `failureRate`: number, `0..100`
- anything invalid → HTTP 400 envelope with per-field error list.

## Example curl session

```bash
# health of all four
curl http://localhost:4101/health
curl http://localhost:4102/health
curl http://localhost:4103/health
curl http://localhost:4104/health

# business calls (ai-primary and ai-fallback share the endpoint contract)
curl http://localhost:4101/api/payments/test
curl http://localhost:4102/api/ai/test
curl http://localhost:4104/api/ai/test
curl http://localhost:4103/api/notifications/test

# inspect current chaos state
curl http://localhost:4102/simulation/state

# make AI slow: 3 second responses
curl -X POST http://localhost:4102/simulation/config \
     -H "Content-Type: application/json" \
     -d '{"latencyMs": 3000}'

# make AI flaky: ~50% of requests fail
curl -X POST http://localhost:4102/simulation/config \
     -H "Content-Type: application/json" \
     -d '{"failureRate": 50}'

# make AI fail always AND slowly (timeout-testing combo)
curl -X POST http://localhost:4102/simulation/config \
     -H "Content-Type: application/json" \
     -d '{"latencyMs": 5000, "failureRate": 100}'

# kill AI entirely (gateway should trip its breaker / fail over)
curl -X POST http://localhost:4102/simulation/config \
     -H "Content-Type: application/json" \
     -d '{"online": false}'

# back to normal
curl -X POST http://localhost:4102/simulation/reset
```

PowerShell equivalents use `Invoke-RestMethod` with `-Method Post -ContentType "application/json" -Body '{"latencyMs": 3000}'`.

## Logging

Every request emits one structured JSON line (same format across the whole
platform), including request id, status code and response time:

```json
{"timestamp":"2026-08-23T23:08:29.441Z","level":"info","service":"ai-service","message":"http_request","context":{"requestId":"c0e63596-...","method":"GET","path":"/api/ai/test","statusCode":200,"durationMs":2507.82}}
```

Set `LOG_LEVEL=debug|info|warn|error` (environment variable) to tune verbosity.

## Design notes

- **Shared core / thin identities** — engine, middleware, controllers and app
  factory exist once; each service contributes name, port, path, default
  latency and a randomized domain payload builder.
- **Snapshot semantics** — config changes never affect requests already
  sleeping inside a latency window.
- **State is in-memory by design** — restart resets everything; cluster-wide
  state comes later (Redis phase).

## Roadmap integration

Phase 3+ gateway will health-probe these services, route traffic to their
business endpoints, trip circuit breakers when `failureRate` climbs, time out
against `latencyMs`, fail over between providers, and stream their structured
logs into the metrics/anomaly pipeline.

**Phase 8 status:** the gateway now observes all of this live — every proxied
call, retry, timeout, rate-limit rejection, circuit transition and failover
becomes a typed resilience event (see `backend/src/observability/`), feeding
`/api/metrics`, `/api/events` and deterministic incident timelines under
`/api/incidents`. The `/simulation/*` controls are exactly the chaos knobs
the Step 8 E2E suite (`backend/scripts/e2e-observability.cjs`) drives while
asserting the incident story: buildup → CRITICAL incident with chronological
timeline → resolution after recovery.

**Phase 9 status:** the same controls now feed anomaly detection —
`backend/scripts/e2e-anomaly.cjs` sets `{ "latencyMs": 2500 }` on this
service (deliberately below the gateway's 3s timeout, so traffic keeps
succeeding) and watches the gateway's rolling baselines flag payment as
WARNING→ANOMALOUS with ranked explanations, then verifies full recovery to
NORMAL (plus an `ANOMALY_RESOLVED` event) after `/simulation/reset`.
