# API Resilience Platform

A TypeScript API gateway that keeps requests flowing when upstream services degrade — rate limiting, retrying, circuit-breaking, and failing over automatically, with an anomaly detector that explains *why* something looks wrong instead of just flagging it.

**Stack:** Node.js / TypeScript / Express (backend) · React / Vite / Tailwind / Recharts (dashboard)

## The problem

Upstream services fail in predictable ways: they get slow, they start erroring, they go down entirely. Most systems handle this reactively — a human notices, checks a dashboard, restarts something. This gateway handles the common cases automatically and gives you a clear picture of what happened and why.

## How it works

```
request → rate limiter → retry (backoff + jitter) → circuit breaker → primary provider
                                                                            │
                                                              on repeated failure
                                                                            ▼
                                                                  fallback provider
                                                                            │
                                                                            ▼
                                          every step emits events → metrics, incidents,
                                                                     anomaly detection
```

A request that fails transiently gets retried with exponential backoff. A provider that fails persistently trips the circuit breaker, and traffic moves to a fallback. The whole sequence — retries, the trip, the failover, recovery — is logged as an incident and checked against the anomaly detector, so you can tell "this is a normal blip" from "this is worse than usual" without guessing.

## Anomaly detection, made explainable

Most anomaly detectors give you a boolean. This one gives you a reason. It tracks latency, error rate, timeout rate, retry rate, and failover rate against a **rolling median + MAD baseline** — deliberately not mean/stddev, because a handful of outliers shouldn't blow out the baseline. Each report includes the current value, the baseline, percent change, z-score, and which metrics are driving the flag, ranked. States move `INSUFFICIENT_DATA → NORMAL → WARNING → ANOMALOUS`.

## Dashboard

A React command center (Overview, Services, Incidents, Anomalies, Metrics, Events) polls the gateway live and handles the states that matter in practice — loading, error, stale data, empty data, insufficient data — rather than assuming the happy path.

## Verified behavior

| Suite | Result |
|---|---:|
| Backend unit tests | 81/81 |
| Circuit breaker E2E | 21/21 |
| Failover E2E | 36/36 |
| Observability E2E | 46/46 |
| Anomaly E2E | 27/27 |
| Frontend build & lint | pass |

Confirmed live: rate limiting under load, retry/backoff behavior, circuit state transitions, automatic failover, incident lifecycle, and recovery back to normal operation.

## Run it

```bash
git clone https://github.com/sanjanaa-10/api-resilience-platform.git
cd api-resilience-platform

cd services && npm install && npm run dev    # simulated upstreams
cd backend  && npm install && npm run dev    # gateway → localhost:4000
cd frontend && npm install && npm run dev    # dashboard → localhost:5173
```

Each runs in its own terminal.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/services` | Service health & circuit state |
| `GET /api/metrics` | Gateway metrics |
| `GET /api/incidents/active` | Active incidents |
| `GET /api/anomalies` | Anomaly reports |

Full list in [`backend/src/routes`](./backend/src/routes).

## What's deliberately out of scope

This is a single-node demo — state is in-memory, not distributed. The anomaly detector surfaces statistical deviations, not root causes; it tells you *where* to look, not *why*. There's no auth layer. A production version would need Redis for distributed rate limiting, a real message bus for the event pipeline, persistent incident storage, and distributed circuit state — deliberately left out here to keep the core resilience logic legible.

## Author

**Sanjana** — [@sanjanaa-10](https://github.com/sanjanaa-10)
