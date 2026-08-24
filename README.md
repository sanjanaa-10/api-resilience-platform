# 🛡️ API Resilience Platform

> A production-inspired API gateway and resilience platform that demonstrates how distributed systems can remain reliable when upstream services become slow, unhealthy, overloaded, or unavailable.

The platform combines **API Gateway routing, rate limiting, retries, exponential backoff, circuit breakers, automatic failover, health monitoring, observability, incident timelines, and explainable statistical anomaly detection** into one end-to-end system.

It also includes a **React-based Resilience Command Center** that visualizes the gateway's live behavior.

## 📌 Overview

Modern applications rarely depend on a single service.

A typical request may travel through:

```text
Client
  ↓
API Gateway
  ↓
Service
  ↓
External Provider
```

If one dependency becomes slow or unavailable, failures can propagate through the entire system.

This project demonstrates how an API gateway can protect the system using multiple resilience mechanisms:

```text
Client
  ↓
React Command Center
  ↓
API Gateway
  ↓
Request ID
  ↓
Rate Limiter
  ↓
Health Monitor
  ↓
Timeout
  ↓
Retry Policy
  ↓
Circuit Breaker
  ↓
Primary Provider
  ↓
Fallback Provider
  ↓
Response
```

At the same time, the gateway records what happened:

```text
Requests
   ↓
Metrics
   ↓
Events
   ↓
Incidents
   ↓
Anomaly Detection
   ↓
React Command Center
```

## ✨ Key Features

### Gateway

- API Gateway
- Service registry
- Request ID propagation
- Upstream timeout protection
- Intelligent retry policy
- Retry classification
- Exponential backoff
- Jitter
- Retry budget
- Token bucket rate limiting
- Circuit breaker
- Automatic failover
- Health monitoring

### Observability

- Structured event stream
- Request lifecycle events
- Retry events
- Timeout events
- Rate-limit events
- Circuit state transitions
- Failover events
- Health changes
- Metrics collection
- Incident aggregation
- Incident timelines

### Anomaly Detection

- Explainable statistical anomaly detection
- Rolling statistical baselines
- Median
- Median Absolute Deviation (MAD)
- Robust z-scores
- Multiple monitored metrics
- Ranked anomaly reasons
- NORMAL / WARNING / ANOMALOUS states
- Cold-start handling
- Historical assessments

### Frontend

The React dashboard provides:

- Overview
- Services
- Incidents
- Anomalies
- Metrics
- Event Stream
- Light theme
- Dark theme
- Live polling
- Loading states
- Error states
- Stale-data states
- Empty states
- Responsive layout

## 🏗️ Architecture

```text
                         ┌─────────────────────┐
                         │       Browser       │
                         │ React Command Center│
                         │      :5173          │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │     API Gateway     │
                         │        :4000        │
                         └──────────┬──────────┘
                                    │
                 ┌──────────────────┼──────────────────┐
                 │                  │                  │
                 ▼                  ▼                  ▼
           Request ID        Token Bucket       Health Monitor
                                    │
                                    ▼
                              Proxy Layer
                                    │
                                    ▼
                             Retry Policy
                                    │
                                    ▼
                            Circuit Breaker
                                    │
                         ┌──────────┴──────────┐
                         │                     │
                         ▼                     ▼
                    AI Primary           AI Fallback
                         │                     │
                         └──────────┬──────────┘
                                    │
                                    ▼
                                 Response

                         ┌─────────────────────┐
                         │    Observability    │
                         ├─────────────────────┤
                         │ Metrics             │
                         │ Events              │
                         │ Incidents            │
                         │ Anomaly Detection   │
                         └─────────────────────┘
```

## 🔄 Request Flow

A normal request follows:

```text
Request
   ↓
Request ID
   ↓
Rate Limiter
   ↓
Gateway Proxy
   ↓
Circuit Breaker
   ↓
Retry Policy
   ↓
Upstream Service
   ↓
Response
```

The gateway also records the request for observability.

## 🚦 Rate Limiting

The gateway implements a **token bucket algorithm** without using a rate-limiting middleware library.

Default configuration:

```text
capacity   = 20 tokens
refillRate = 10 tokens/second
```

Each client receives an independent bucket.

One accepted gateway request consumes one token.

If no token is available, the gateway returns:

```text
HTTP 429 Too Many Requests
```

Example response:

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests",
    "requestId": "...",
    "retryAfterSeconds": 1
  }
}
```

The gateway exposes:

```text
RateLimit-Limit
RateLimit-Remaining
RateLimit-Reset
Retry-After
```

### Client Identity

The current implementation uses:

```text
X-Client-ID
```

and falls back to the request IP.

In a production system, client identity would normally come from a trusted identity such as:

- authenticated user ID
- API key
- service identity

An arbitrary client-controlled header should not be treated as a secure identity mechanism.

### Important Retry Interaction

A client request consumes **one rate-limit token**.

Internal retries do not consume additional tokens.

```text
Client Request
      │
      ▼
  1 token
      │
      ▼
   Attempt 1
      │
      ▼
    Retry
      │
      ▼
   Attempt 2
      │
      ▼
   Response
```

Retries are an internal implementation detail of the original request.

## 🔁 Intelligent Retries

The gateway does not blindly retry every failure.

Retry classification distinguishes between transient and non-transient failures.

Retryable HTTP statuses include:

```text
502 Bad Gateway
503 Service Unavailable
504 Gateway Timeout
```

Timeouts and eligible network failures may also be retried.

Other failures are not automatically retried.

## 📈 Exponential Backoff

Retries use exponential backoff:

```text
delay = min(baseDelay × 2^(attempt-1), maxDelay)
```

The implementation also adds **equal jitter**.

Conceptually:

```text
Attempt 1
   ↓
small delay + jitter

Attempt 2
   ↓
larger delay + jitter

Attempt 3
   ↓
larger delay + jitter
```

Without backoff, clients can repeatedly hammer an already unhealthy dependency.

## 🎲 Jitter

Jitter randomizes retry delays.

Without jitter:

```text
Client A ─────retry─────┐
Client B ─────retry─────┤
Client C ─────retry─────┤
Client D ─────retry─────┘
                         ↓
                    Retry Storm
```

With jitter:

```text
Client A ─────retry───────────
Client B ───retry────
Client C ───────retry──────
Client D ──retry──
```

This reduces synchronized retry bursts.

## ⏱️ Retry Budget

Retries are bounded by a total retry budget.

This prevents a misconfigured retry policy from allowing requests to remain in the gateway indefinitely.

The system considers:

```text
Per-attempt timeout
       +
Retry delays
       +
Number of attempts
       =
Total request budget
```

The budget provides a hard upper bound for the retry loop.

## 🔌 Circuit Breaker

The gateway implements a circuit breaker to stop repeatedly calling a failing dependency.

The state machine is:

```text
             failures
 CLOSED ─────────────────► OPEN
    ▲                        │
    │                        │ timeout
    │                        ▼
    └──────── success ─── HALF_OPEN
                              │
                              │ failure
                              ▼
                            OPEN
```

### CLOSED

Normal operation.

Requests are allowed through.

### OPEN

The dependency is considered unhealthy.

Requests are blocked from repeatedly hitting the dependency.

### HALF_OPEN

A controlled probe request tests whether the dependency has recovered.

If successful:

```text
HALF_OPEN → CLOSED
```

If unsuccessful:

```text
HALF_OPEN → OPEN
```

## 🔀 Automatic Failover

The gateway supports fallback providers.

Example:

```text
Client
  ↓
Gateway
  ↓
AI Primary
  │
  ├── success ───────────────► Response
  │
  └── failure
        ↓
      Retry
        ↓
      Failure
        ↓
     Failover
        ↓
   AI Fallback
        ↓
     Response
```

This allows the system to continue serving requests when the primary provider is unavailable.

The dashboard exposes failover events and incident timelines.

## ❤️ Health Monitoring

The gateway periodically checks registered services.

For each service it tracks:

- health status
- probe latency
- last check time
- consecutive failures
- last error
- circuit state

Example services:

```text
payment
ai-primary
ai-fallback
notification
```

## 📊 Observability

The platform contains a structured observability layer.

Every event contains fields such as:

```text
eventId
timestamp
service
severity
requestId
eventType
message
metadata
```

Supported event types include:

```text
REQUEST_STARTED
REQUEST_COMPLETED
REQUEST_FAILED
RETRY_ATTEMPT
RATE_LIMITED
CIRCUIT_OPENED
CIRCUIT_HALF_OPEN
CIRCUIT_CLOSED
FAILOVER_STARTED
FAILOVER_COMPLETED
UPSTREAM_TIMEOUT
HEALTH_CHANGED
ANOMALY_DETECTED
ANOMALY_RESOLVED
```

Observability is intentionally isolated from request handling.

A failure in an observability sink must not break production traffic.

## 📈 Metrics

The gateway collects metrics including:

```text
requestCount
successCount
failureCount
timeoutCount
retryCount
failoverCount
circuitOpenCount
averageLatencyMs
p95LatencyMs
```

Metrics are exposed through:

```text
GET /api/metrics
```

The frontend converts live metrics into:

- throughput charts
- success-rate charts
- p95 latency charts
- cumulative counters

## 🚨 Incident Aggregation

The platform builds incident narratives from the event stream.

An incident can contain:

```text
incidentId
service
startedAt
endedAt
status
severity
title
summary
eventCount
failoverOccurred
circuitOpened
affectedRequests
timeline
```

The timeline reconstructs what happened in chronological order.

Example:

```text
20:46:07  Attempt 1 failed
20:46:07  Retry scheduled
20:46:07  Attempt 2 failed
20:46:08  Failover started
20:46:08  Failover completed
20:46:10  Health changed
20:46:16  Circuit opened
...
20:47:20  Circuit half-open
20:47:21  Probe succeeded
20:47:21  Circuit closed
```

This turns raw events into an incident story.

## 🧠 Explainable Anomaly Detection

The platform includes a statistical anomaly detector.

It is intentionally **not a black-box machine-learning model**.

The detector monitors:

```text
Average latency
P95 latency
Error rate
Timeout rate
Retry rate
Failover rate
```

Each service maintains a bounded rolling baseline.

### Statistical Baseline

The detector uses:

```text
Median
+
Median Absolute Deviation (MAD)
```

instead of relying only on mean and standard deviation.

This makes the baseline more resistant to individual extreme spikes.

### Robust Z-Score

The detector calculates a one-sided robust deviation score.

Only increases that indicate degradation are treated as anomalies.

The resulting score is normalized to:

```text
0 → 1
```

The highest metric deviation determines the overall anomaly score.

### Anomaly States

```text
INSUFFICIENT_DATA
       ↓
     NORMAL
       ↓
    WARNING
       ↓
  ANOMALOUS
```

A cold-start detector does not invent a verdict.

Instead:

```text
status = INSUFFICIENT_DATA
score  = null
```

until enough observations are available.

### Explainable Anomaly Reasons

Every anomaly can include:

```text
metric
current
baseline
changePercent
zScore
```

Example:

```json
{
  "metric": "avgLatencyMs",
  "current": 706,
  "baseline": 135.6,
  "changePercent": 421,
  "zScore": 46.05
}
```

This answers:

> Why did the detector think something was wrong?

instead of only displaying:

```text
ANOMALOUS
```

## 🖥️ Resilience Command Center

The frontend is a React-based operational dashboard.

### Overview

The Overview page provides:

- success rate
- average latency
- p95 latency
- retries
- failovers
- circuit opens
- service health
- incidents
- anomaly information

### Services

The Services page displays:

- provider health
- latency
- request counts
- errors
- circuit state
- anomaly state
- probe details

### Incidents

The Incidents page provides:

- active incidents
- resolved incidents
- severity
- affected service
- affected requests
- circuit state
- failover state
- chronological timeline

### Anomalies

The Anomalies page displays:

- anomaly score
- current status
- sample count
- baseline information
- current metrics
- anomaly reasons
- assessment history

### Metrics

The Metrics page provides:

- request totals
- success totals
- failures
- timeouts
- retries
- failovers
- circuit opens
- rate-limit events
- throughput
- success rate
- p95 latency

Charts are generated from real gateway traffic.

### Events

The Event Stream provides a searchable view of the gateway's raw observability events.

Filters include:

```text
Service
Event type
Severity
Limit
Search
```

Events can be inspected using:

```text
message
service
requestId
timestamp
severity
event type
```

## 🧪 Chaos / Failure Simulation

The project includes simulated upstream services so resilience behavior can be tested without relying on real external providers.

The simulator can be configured for scenarios such as:

```text
latency
failure rate
failure status
online/offline state
```

Example:

```text
Normal
   ↓
Inject latency
   ↓
Retry / timeout behavior
   ↓
Increase failures
   ↓
Circuit opens
   ↓
Failover
   ↓
Recovery
   ↓
Circuit closes
```

This makes resilience behavior observable and repeatable.

## 🗂️ Project Structure

```text
api-resilience-platform/
│
├── backend/
│   ├── src/
│   │   ├── anomaly/
│   │   ├── config/
│   │   ├── controllers/
│   │   ├── middleware/
│   │   ├── observability/
│   │   ├── routes/
│   │   ├── services/
│   │   └── types/
│   │
│   ├── scripts/
│   │   ├── anomaly.test.ts
│   │   ├── observability.test.ts
│   │   ├── e2e-anomaly.cjs
│   │   └── e2e-observability.cjs
│   │
│   └── README.md
│
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── lib/
│   │   ├── pages/
│   │   ├── services/
│   │   ├── styles/
│   │   └── types/
│   │
│   └── README.md
│
├── services/
│   └── simulated upstream services
│
└── README.md
```

## ⚙️ Technology Stack

### Backend

- Node.js
- TypeScript
- Express

### Frontend

- React
- TypeScript
- Vite
- Tailwind CSS
- Recharts

### Testing

- Node.js built-in test runner
- End-to-end test scripts

## 🚀 Running the Project

### Prerequisites

Install:

- Node.js
- npm

### 1. Clone

```bash
git clone https://github.com/sanjanaa-10/api-resilience-platform.git
cd api-resilience-platform
```

### 2. Start simulated services

Open a terminal:

```bash
cd services
npm install
npm run dev
```

The simulated providers run on their configured ports.

### 3. Start the gateway

Open another terminal:

```bash
cd backend
npm install
npm run dev
```

Gateway:

```text
http://localhost:4000
```

### 4. Start the frontend

Open another terminal:

```bash
cd frontend
npm install
npm run dev
```

Dashboard:

```text
http://localhost:5173
```

> On Windows, the current project path contains `&` (`API R&F`), which can interfere with npm's command shims in some environments. If that occurs, invoke the underlying binaries directly with Node or move/rename the project directory to a path without special shell characters.

## 🔌 API Endpoints

### Services

```text
GET /api/services
```

Returns registered services and their current health and circuit state.

### Metrics

```text
GET /api/metrics
```

Returns gateway metrics.

### Events

```text
GET /api/events
```

Optional filters:

```text
service
type
severity
limit
```

### Incidents

```text
GET /api/incidents/active
GET /api/incidents/:id
```

### Anomalies

```text
GET /api/anomalies
GET /api/anomalies/:service
GET /api/anomalies/:service/history
```

## 🧪 Testing

The project includes automated tests for the major resilience components.

Verified suites include:

- Circuit Breaker
- Rate Limiting
- Failover
- Observability
- Anomaly Detection

Verified results:

| Suite | Result |
|---|---:|
| Backend unit tests | **81/81** |
| Circuit breaker E2E | **21/21** |
| Failover E2E | **36/36** |
| Observability E2E | **46/46** |
| Anomaly E2E | **27/27** |

Frontend verification included:

- TypeScript build
- Vite production build
- oxlint
- Live API contract verification
- Browser route verification
- Light/dark theme verification

## 📋 Resilience Scenarios

### Normal Traffic

```text
Request → Primary → Success
```

### Transient Failure

```text
Request
   ↓
503
   ↓
Retry
   ↓
Success
```

### Persistent Failure

```text
Request
   ↓
503
   ↓
Retry
   ↓
Retry
   ↓
Circuit
   ↓
Failure / Failover
```

### High Latency

```text
Request
   ↓
Slow upstream
   ↓
Timeout
   ↓
Retry / controlled failure
```

### Primary Provider Outage

```text
Primary unavailable
        ↓
Circuit opens
        ↓
Failover
        ↓
Fallback serves request
```

### Recovery

```text
Primary recovers
        ↓
Half-open probe
        ↓
Successful probe
        ↓
Circuit closes
```

### Anomaly

```text
Normal baseline
        ↓
Latency/failure/failover spike
        ↓
Robust statistical deviation
        ↓
ANOMALOUS
        ↓
Explainable reason
```

## 🧩 Important Design Decisions

### Why rate limit before retries?

Rate limiting protects the gateway before expensive downstream work begins.

```text
Rate Limiter
     ↓
Retry
     ↓
Upstream
```

If rate limiting happened after retries, a single client request could generate multiple downstream attempts before being rejected.

### Why don't retries consume additional tokens?

The client made one request.

The retry is an internal gateway decision.

Therefore:

```text
1 client request = 1 rate-limit token
```

This keeps the client quota predictable.

### Why exponential backoff?

A dependency experiencing failures needs time to recover.

Increasing delays reduce pressure on the dependency.

### Why jitter?

Multiple clients retrying at the same time can create a retry storm.

Jitter spreads retries over time.

### Why circuit breaker?

Retries are useful for short transient failures.

They are harmful when the dependency is continuously unavailable.

The circuit breaker provides cross-request memory and stops repeatedly calling a known-failing dependency.

### Why failover?

If an alternative provider is available, traffic can continue even when the primary provider is unavailable.

### Why observability?

Resilience mechanisms without visibility are difficult to operate.

The platform records:

```text
What happened?
When did it happen?
Which service was affected?
Which request was involved?
Why did the gateway react?
```

### Why explainable anomaly detection?

The goal is not simply:

```text
ANOMALY = TRUE
```

The goal is:

```text
ANOMALY
   ↓
Metric
   ↓
Current value
   ↓
Baseline
   ↓
Percentage change
   ↓
Robust z-score
```

An engineer can therefore understand the reason behind the detector's decision.

## 🌐 Distributed-System Limitations

The current implementation intentionally uses in-memory state.

This is suitable for demonstrating the algorithms and for a single gateway instance.

However, multiple gateway instances would have independent state.

For example:

```text
             Load Balancer
              /                       ▼            ▼
        Gateway A      Gateway B
           │              │
        Bucket A        Bucket B
```

The same client could therefore receive different rate limits depending on which instance handles the request.

Similarly, in-memory circuit and observability state would not automatically be shared.

## 🔮 Production Evolution

A production-scale version could introduce:

```text
Redis
   ↓
Distributed rate limiting / shared state

Kafka
   ↓
Distributed event pipeline

Prometheus
   ↓
Metrics collection

PostgreSQL
   ↓
Persistent incidents

Kubernetes
   ↓
Container orchestration
```

These technologies are intentionally **not required by the current implementation**.

The project focuses first on understanding and implementing the resilience algorithms themselves.

## ⚠️ Known Limitations

Current limitations include:

- in-memory state
- single gateway instance
- no distributed rate limiter
- no persistent incident database
- no distributed event bus
- anomaly detection is statistical rather than root-cause analysis
- slow metric drift can gradually influence rolling baselines
- frontend production bundle contains a Recharts chunk-size advisory

These are documented design limitations rather than hidden behavior.

## 🔐 Security Notes

The current simulator is designed for local development and experimentation.

It should not be treated as a production security boundary.

In particular:

- `X-Client-ID` is not a trusted authentication mechanism
- upstream simulator endpoints should not be exposed publicly
- production deployments require authentication and authorization
- secrets should be stored outside source control
- HTTPS should be used for real deployments
- rate limiting identity should come from trusted authentication context

## 🎯 Learning Goals

This project demonstrates practical understanding of:

- API gateway architecture
- distributed-system failure modes
- retry strategies
- exponential backoff
- jitter
- retry budgets
- rate limiting
- token buckets
- circuit breakers
- health checks
- automatic failover
- structured logging
- observability
- incident management
- statistical anomaly detection
- frontend operational dashboards

## 💬 Interview Summary

A concise way to explain the project:

> **I built an API resilience platform around a TypeScript gateway that protects upstream services using token-bucket rate limiting, timeout-aware retries with exponential backoff and jitter, circuit breakers, and automatic failover. I then added an observability layer that converts request and resilience events into metrics and incident timelines. Finally, I built an explainable anomaly detector using rolling median/MAD baselines and robust z-scores, and visualized the entire system through a React command center using live gateway data.**

## 📸 Dashboard

The React command center provides a visual view of the system:

```text
Overview
Services
Incidents
Anomalies
Metrics
Events
```

The dashboard is designed to make resilience behavior observable rather than hidden inside backend logs.

## 📜 License

This project is intended for educational, portfolio, and demonstration purposes.

## 👩‍💻 Author

**Sanjana**

GitHub: https://github.com/sanjanaa-10/api-resilience-platform
