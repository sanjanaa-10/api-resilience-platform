# API Resilience & Failover Platform — Backend (API Gateway)

Production-style platform that protects applications from unhealthy APIs:
API gateway, health monitoring, retry logic, rate limiting, circuit breaker,
automatic failover, observability and ML anomaly detection.

**Status: Phase 7 — automatic failover across provider groups.**

| Capability | Status |
| --- | --- |
| Express + TypeScript strict foundation | Done |
| Service registry (typed, centralized) | Done |
| Health monitor (periodic probes, transition logging) | Done |
| Registry-driven proxy routes | Done |
| Upstream timeout -> controlled 504 | Done |
| Upstream failure normalization (500/503/refused/malformed) | Done |
| Request observability (requestId correlation end-to-end) | Done |
| Retry logic | Done |
| Rate limiting | Done |
| Circuit breaker (per service, CLOSED/OPEN/HALF_OPEN) | Done |
| Automatic failover (provider groups, budget=1) | Done |
| ML anomaly detection / dashboard | Planned |

Companion project: [`../services`](../services/README.md) — four simulated
unreliable upstreams this gateway is tested against (payment, ai-primary,
ai-fallback, notification).

---

## Architecture

```
                     ┌───────────────────────────────────────────────────┐
 Client ────────────►│  GATEWAY :4000                                    │
                     │                                                   │
                     │  requestLogger ── requestId + X-Request-Id        │
                     │       │                                           │
                     │  routes/index ──► gateway.routes                  │
                     │       │               ├── GET  /api/services      │
                     │       │               ├── POST /api/services/check│
                     │       │               └── GET /api/:svc/test      │
                     │       ▼                                           │
                     │  config/services.config  ◄── single topology truth│
                     │       │                                           │
                     │  proxy.service ── fetch + AbortSignal.timeout     │
                     │  healthMonitor ── interval probe loop             │
                     │       └── ServiceHealthState snapshots            │
                     │  errorHandler (single exit point)                 │
                     └───────────────────────────────────────────────────┘
                          │                            │
                    proxy fetch                  probes every
                  :4101 / :4102 / :4103          HEALTH_CHECK_INTERVAL_MS
```

Design principles:

- **Registry-driven** — one `ServiceRegistration[]` plus `ProviderGroup[]` in
  `config/services.config.ts` is the only place a URL or path appears. Proxy
  routes are *generated* by iterating the groups; adding an upstream (or a
  whole failover group) = one entry, zero route code.
- **One reusable proxy mechanism** — `proxyBusinessRequest()` serves every
  provider; `executeWithFailover()` orchestrates it across a group.
- **Shared upstream client** — `upstreamClient.service.ts` wraps native
  `fetch` with `AbortSignal.timeout` and classifies outcomes
  (`response | timeout | network-error`) for the proxy, the monitor.
- **Dependency injection** — `createApp({ healthMonitor })`; the app factory
  never starts timers, so tests can inject fakes and run without ports.
- **Graceful lifecycle** — shutdown order: stop probe timer → close server →
  force-exit deadline.
- **Never crash on upstream failure** — every proxy path resolves to a
  classified outcome or is caught and routed to the error middleware.

## Request lifecycle (`GET /api/ai/test`)

1. `requestId.middleware` resolves the correlation id (reusing a valid
   client `X-Request-ID`), echoes it as `X-Request-ID`.
2. Route table (generated from the provider groups) matches `/api/ai/test`
   → the **ai group**: providers `[ai-primary (:4102), ai-fallback (:4104)]`,
   target `/api/ai/test`.
3. `executeWithFailover()` walks the group in strict forward order. For the
   primary: circuit admission pre-check, then `proxyBusinessRequest` runs
   the retry executor — each attempt sends `x-request-id: <gateway
   requestId>` with its own hard deadline covering the entire call including
   body read; transient failures are retried with exponential backoff +
   jitter (see *Retry system*). On an eligible failure (or a blocked
   admission), the failover policy may move the SAME logical request to the
   fallback, which gets its own gates + retry loop.
4. Outcome mapping (applied to whichever provider served):

   | Outcome | HTTP | Error code |
   | --- | --- | --- |
   | upstream 2xx | upstream status | body passthrough (+ `retry` metadata if retried, + `failover` metadata) |
   | upstream 503 | 503 | `UPSTREAM_UNAVAILABLE` |
   | other upstream errors | upstream status | `UPSTREAM_ERROR` |
   | deadline exceeded | 504 | `UPSTREAM_TIMEOUT` |
   | connection refused / DNS / reset | 503 | `UPSTREAM_UNAVAILABLE` |
   | non-JSON body | 502 | `UPSTREAM_INVALID_RESPONSE` |

5. Structured log lines per attempt (`proxy_attempt`) and per request
   (`proxy_request`, `proxy_failover` / `proxy_failover_summary`) carry
   `requestId`, `service`, `attempt`, `outcome`, `retry`, `retryReason`,
   `delayMs`, `attempts`, `retries`, `totalDurationMs`, and on failover the
   full provider trace (see *Automatic failover*).

## Request ID behavior

Every request has a correlation id, resolved by `requestId.middleware.ts`
(the first middleware in the chain):

1. If the client sends `X-Request-ID` and it is valid (first token only,
   non-empty, <= 128 chars), it is **reused** — enabling tracing across hops.
2. Otherwise a UUID is generated.
3. The id is always echoed back on the response header `X-Request-ID`.
4. Every structured log line carries it plus its origin
   (`requestIdSource: "client" | "gateway"`).
5. Proxied requests forward it upstream as `x-request-id`; the upstream's
   own id returns in the payload and is logged as `upstreamRequestId`.

## Retry system

Two modules with a hard separation of **policy** (data) and **execution**
(mechanics):

- `retryPolicy.service.ts` — defaults (`maxAttempts 3 / baseDelayMs 100 /
  maxDelayMs 1000`), the retryable-status set, and the idempotency guard.
  `maxAttempts` INCLUDES the initial request: attempt 1 = initial,
  attempt 2 = retry 1, attempt 3 = retry 2.
- `retry.service.ts` — generic `executeWithRetry()` loop. It knows nothing
  about HTTP: the caller supplies an operation plus a pure `decide()`
  classifier; the executor owns counting, backoff scheduling, safety
  guards, and observability hooks.

### Classification (what gets retried)

| Failure | Retried? | Why |
| --- | --- | --- |
| network error (refused/reset/DNS) | YES | classic transient blip |
| per-attempt timeout | YES | upstream may just be slow once |
| HTTP 502 / 503 / 504 | YES | transient gateway/upstream conditions |
| HTTP 500 & other 5xx | NO | usually deterministic bugs — replaying adds load without benefit (deliberate, set-driven policy) |
| any 4xx | NEVER | identical request ⇒ identical rejection |
| non-JSON response | NO | conservative default; may be permanent contract break |

### Backoff formula + jitter

```
capped = min(baseDelayMs * 2^(failedAttempt - 1), maxDelayMs)
delay  = capped/2 + random(0, capped/2)        # equal jitter
```

Delays are applied via a promise-wrapped `setTimeout` — the event loop is
never blocked. WHY JITTER: when many clients fail simultaneously they would
otherwise all retry at the same instant, synchronizing their load into a
**retry storm** that re-triggers the very outage they are recovering from.
Randomized bounded delays desynchronize clients while keeping growth
exponential; equal jitter keeps successive attempt ranges non-overlapping
(`[50,100]` then `[100,200]` ms with defaults), which makes behavior
predictable and test-verifiable.

### Request safety

Only idempotent methods are replayed (`GET`, `HEAD`, `OPTIONS`). The proxy
endpoints are GET-only today; if POST support arrives it will start
single-attempt until real idempotency machinery exists (idempotency keys /
retry tokens). Retrying a blind POST is dangerous because a timeout does
not reveal whether the server executed the operation before the response
was lost — the retry can double-charge a card or duplicate an order.

### Timeout interaction

Two independent bounds:

- **Per-attempt timeout** (`UPSTREAM_TIMEOUT_MS`, default 3000): each
  attempt carries its own `AbortSignal.timeout(...)` covering connection +
  headers + body read. A slow attempt never eats another attempt's budget.
- **Total retry budget** (`RETRY_TOTAL_BUDGET_MS`, default 10000):
  wall-clock ceiling for attempts + backoff combined, checked before every
  retry. With defaults the worst case is ~3×3000ms + ~300ms backoff ≈ 9.3s,
  inside budget; the guard also caps runaway configs
  (e.g. `RETRY_MAX_ATTEMPTS=20` cannot produce minutes-long requests).

There is deliberately NO single umbrella timeout around the loop.

### Observability

Every proxied request logs one line per attempt:

```json
{"message":"proxy_attempt","context":{"requestId":"5fc4d500…","service":"ai",
 "attempt":1,"status":503,"outcome":"HTTP_503","retry":true,
 "retryReason":"HTTP_503","delayMs":51}}
{"message":"proxy_attempt","context":{"requestId":"5fc4d500…","service":"ai",
 "attempt":2,"status":200,"outcome":"SUCCESS","retry":false}}
```

plus summary fields (`attempts`, `retries`, `totalDurationMs`) on the final
request log and inside error envelopes (`error.upstream.retry`).

### Response metadata

A success achieved only after retries carries safe public metadata in its
body — nothing about internal delays or reasons:

```json
{ "status": "success", "...": "...", "retry": { "attempts": 2, "retries": 1 } }
```

## Rate limiting

Token bucket rate limiter per client.

### Algorithm

Each client has an in-memory token bucket. Configuration (via environment
variables):

| Variable | Default | Purpose |
| --- | --- | --- |
| `RATE_LIMIT_CAPACITY` | 20 | Max tokens per bucket |
| `RATE_LIMIT_REFILL_RATE` | 10 | Tokens added per second |
| `RATE_LIMIT_CLEANUP_INTERVAL_MS` | 60000 | How often to purge inactive buckets |

- **Capacity**: the bucket can hold at most `capacity` tokens.
- **Refill rate**: `refillRate` tokens are added every second, capped at
  `capacity`.
- **Consumption**: each accepted request consumes exactly 1 token.
- **Refill calculation**: tokens are recomputed from elapsed time since the
  last refill: `newTokens = elapsedSeconds * refillRate`, then
  `tokens = min(capacity, oldTokens + newTokens)`.

No per-client timer is created. Refill is always calculated on-demand from
the elapsed time, making the implementation deterministic and lightweight.

### Client identity

Clients are identified using the `X-Client-ID` header. If absent, the
request IP address is used as fallback:

```
X-Client-ID: <client-chosen-identifier>
```

If `X-Client-ID` is not present, the gateway falls back to the request IP.

**Why a production system may use something other than arbitrary client headers:**

- **Authenticated user ID** — verified against an identity provider (OAuth,
  JWT, session cookie). The client cannot forge this.
- **API key** — registered key passed via `Authorization` or a dedicated
  header, validated against a keyspace. Rates can be configured per key.
- **Service identity** — mutual TLS or shared secret between gateway and
  upstream services. Trust is established by the transport, not by the
  client sending a header.

The header-based approach is appropriate for a single-gateway prototype but
can be spoofed; a real deployment would bind the identifier to authentication
context.

### Response headers

Every rate-limited request exposes these standard-style headers:

| Header | Description |
| --- | --- |
| `RateLimit-Limit` | Maximum number of requests permitted in the bucket |
| `RateLimit-Remaining` | Tokens still available after this request |
| `RateLimit-Reset` | Unix timestamp (seconds) when the bucket will be full again |
| `Retry-After` | Seconds until at least 1 token is available (only when 429) |

When the limit is exceeded (HTTP 429), all four headers are set, plus the
response body follows this envelope:

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

### Middleware position

Rate limiting sits **after** request ID resolution and **before** the proxy
and retry logic in the middleware chain:

```
Request
  ↓
Request ID
  ↓
Rate Limiter     ← new: one token consumed per client request
  ↓
Proxy
  ↓
Retry Policy
  ↓
Upstream
```

**Why before expensive upstream calls:** rate limiting rejects unconditionally
before any upstream fetch or retry is attempted. This prevents wasted
upstream CPU, connection overhead, and retry budget consumption when the
client has already exceeded their quota. One client request = one gateway
rate-limit token, regardless of how many internal retries the proxy performs.

### Interaction with retries

A client request that internally retries (e.g., transient 503 from upstream)
still consumes **only one** rate-limit token. The token is consumed once when
the gateway accepts the request; internal retries are an implementation detail
of that single gateway request and should not double-charge the client's
quota.

### Distributed system limitation

This limiter is **in-memory only**. In a horizontally scaled deployment with
multiple gateway instances, each node has its own bucket and tokens are not
shared. For multi-node deployment, a distributed store (e.g. Redis) would be
required to share bucket state across instances. This limitation is
acknowledged and documented for future expansion.

### Cleanup inactive buckets

Inactive client buckets are pruned every `RATE_LIMIT_CLEANUP_INTERVAL_MS`
(default 60 seconds). A bucket that has had no activity for 5 minutes is
removed. This prevents unbounded growth in a single-gateway deployment but
is NOT sufficient for horizontal scaling — distributed rate limiting would
require a shared store.

### Configuration

```env
# Rate limiting
RATE_LIMIT_CAPACITY=20
RATE_LIMIT_REFILL_RATE=10
RATE_LIMIT_CLEANUP_INTERVAL_MS=60000
```

### Test examples

```bash
# Under the limit (capacity=5, refill=1): first 5 requests succeed
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "%{http_code} " http://localhost:4000/api/payment/test
done
# Output: 200 200 200 200 200

# Burst: 6th request gets 429
curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/api/payment/test
# Output: 429

# Different clients isolated (use different X-Client-ID):
curl -s -H "X-Client-ID: client-a" -o /dev/null -w "%{http_code}" http://localhost:4000/api/payment/test
# client-a: 429 (exhausted)
# client-b (implicit IP-based): 200 (fresh bucket)

# Response headers on allow:
curl -i http://localhost:4000/api/payment/test | grep -E "RateLimit-(Limit|Remaining|Reset)|Retry-After"
```

## Circuit breaker

Per-service admission control based on recent **request outcomes**. One
misbehaving upstream is cut off quickly instead of dragging every request
through the full timeout + retry cycle.

### State machine

```
             failureThreshold consecutive failing logical requests
   CLOSED ──────────────────────────────────────────────────► OPEN
      ▲                                                        │
      │ probe request succeeds                        openDurationMs elapsed
      │                                               (lazy — checked on next arrival)
      └──────────────────────────────────────────────────── ◄─ HALF_OPEN
                                                  probe fails ► back to OPEN
```

| State | Meaning | Traffic |
| --- | --- | --- |
| `CLOSED` | Normal operation | all requests proxied |
| `OPEN` | Tripped; protecting upstream + caller | rejected instantly, no upstream call |
| `HALF_OPEN` | Cool-off elapsed; testing recovery | at most `halfOpenMaxRequests` concurrent probes; others fail fast |

Transitions are **lazy**: no timer per circuit. `OPEN → HALF_OPEN` is
evaluated from `now - openedAt >= openDurationMs` whenever a request arrives —
the same elapsed-time pattern as token-bucket refill.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | 5 | Consecutive failed logical requests that trip the circuit (per service) |
| `CIRCUIT_BREAKER_OPEN_DURATION_MS` | 10000 | Cool-off before probes are admitted |
| `CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS` | 1 | Concurrent recovery probes allowed in HALF_OPEN |

State is maintained **per provider**: `payment → CLOSED`, `ai-primary →
OPEN`, `ai-fallback → CLOSED`, `notification → CLOSED` is a normal, expected
combination — and exactly what makes failover work: while the primary's
circuit rejects, the fallback's stays closed and keeps serving. One provider's
failures never touch another's circuit.

### Failure classification

Counted against the threshold (final outcome of a LOGICAL request):

| Outcome | Counted? | Rationale |
| --- | --- | --- |
| network error (`unreachable`) | YES | classic unavailability |
| per-attempt deadline exceeded (`timeout`) | YES | overloaded / hanging upstream |
| upstream HTTP 502 / 503 / 504 | YES | transient gateway-class failures |
| upstream HTTP 4xx | NO | client errors repeat identically; not the dependency's fault |
| upstream HTTP 500 & other 5xx | NO | deterministic bugs — replaying traffic into them opens circuits without protecting anyone |
| non-JSON response (`invalid-response`) | NO | contract break, not availability |
| gateway fast-fail (`CIRCUIT_OPEN` rejection) | NEVER | rejections must not feed themselves |
| rate-limit rejection (429) | NO | happened before admission, upstream untouched |

A successful final outcome resets `failureCount` to 0.

### Retry interaction (documented design decision)

One client request = ONE circuit decision before the retry loop + ONE outcome
recording after it. Internal retries are invisible to the breaker:

- The pre-check runs once, before any upstream work: an OPEN circuit rejects
  in microseconds instead of paying N × timeout of retries into a dead upstream.
- Only the FINAL attempt's outcome is recorded. Counting every failed attempt
  would let a single unlucky request burn multiple failure slots and would
  measure retry-loop internals rather than "is this dependency serving?".
  Threshold 5 therefore means *5 consecutive requests whose ultimate result
  was failure*.
- HALF_OPEN admits exactly one probe request (the whole logical request,
  including its internal retries); its final verdict closes or reopens the
  circuit. No other traffic passes while the probe is in flight.

### Health monitor interaction (no duplicated responsibility)

Two deliberate lenses on the same dependency:

- **Health monitor** — background prober, answers "is the service up?" for
  observability. Never trips or resets the breaker; monitor probes are not
  counted as circuit outcomes.
- **Circuit breaker** — admission control fed by live request outcomes;
  answers "should THIS request through?".

They can legitimately disagree for a while (monitor says unhealthy during the
OPEN cool-off; breaker says CLOSED for an isolated blip). `GET /api/services`
exposes both views side by side:

```json
{
  "name": "ai-primary",
  "status": "unhealthy",
  "circuit": {
    "state": "OPEN",
    "failureCount": 5,
    "openedAt": "2026-08-24T09:57:04.589Z"
  }
}
```

(`circuit` is merged into each service entry at the route layer; the
failover group's fallback appears as its own row with its own health +
circuit state.)

### Fail-fast behavior

While OPEN (or HALF_OPEN with its probe slot taken), requests return:

```json
HTTP 503
{
  "success": false,
  "error": {
    "code": "CIRCUIT_OPEN",
    "message": "Circuit is open for upstream provider payment.",
    "statusCode": 503,
    "requestId": "…",
    "service": "payment",
    "upstream": { "reason": "NO_ELIGIBLE_PROVIDER", "attempts": [ … ] }
  }
}
```

(The `attempts` trace lists why each group member was skipped — for a
singleton group it is just the primary's `CIRCUIT_OPEN` record. Measured in
verification: **4 ms** vs ~590 ms through the normal retry path — two orders
of magnitude faster, and zero load on the struggling upstream.)

### Concurrency model

Node.js runs JS on a single event-loop thread, so code between `await`s is
atomic — but that alone does NOT make the breaker safe: the classic
check-then-act race spans await points. If K concurrent requests each checked
"probe slot free?" and only later recorded their outcome around awaits, all K
would pass. The guard: **every state read-modify-write happens synchronously
inside `canRequest()` / `recordSuccess()` / `recordFailure()`** — these
functions contain zero awaits, so each is atomic on the event loop, and the
HALF_OPEN probe slot is reserved synchronously at admission time (before any
I/O). Result: exactly one probe under any concurrency; failure counts stay
consistent. A multi-threaded runtime would additionally need mutexes/CAS —
not needed here, which is why no locks exist.

### Distributed deployment limitation

State is **in-memory per gateway instance**. Behind N instances:
effective trip threshold ≈ N × configured (each instance counts separately),
recovery probes happen per instance, and instances can disagree (one OPEN,
another CLOSED). Sufficient for this single-instance platform; production
horizontal scaling would centralize breaker state (e.g. Redis) or use a
coordinated strategy — deliberately out of scope here.

### Observability

Every transition logs one structured line carrying service, previousState,
newState, failureCount, reason, requestId and timestamp:

```json
{"message":"circuit_state_change","context":{"service":"ai-primary",
 "previousState":"CLOSED","newState":"OPEN","failureCount":5,
 "reason":"failure_threshold_reached","requestId":"9bf454b4…"}}
```

Reasons observed: `failure_threshold_reached`, `open_duration_elapsed`,
`probe_success`, `probe_failed`. Fast-fails log `circuit_fast_fail`.

## Automatic failover

When one provider of an equivalent set fails transiently, the SAME logical
request is transparently re-executed against another provider — the client
still gets one response, one rate-limit token, one requestId.

### Provider groups

Pure data in the registry (`PROVIDER_GROUPS`):

| Group | Public route | Providers (ordered) |
| --- | --- | --- |
| `ai` | `GET /api/ai/test` | `ai-primary` :4102 → `ai-fallback` :4104 |
| `payment` | `GET /api/payment/test` | `payment` :4101 |
| `notification` | `GET /api/notification/test` | `notification` :4103 |

Singleton groups behave exactly like direct proxying. Because every provider
is a first-class registry entry, health monitoring and circuit breaking track
each one **independently** with zero special-casing.

### Execution flow

```
Request ID ─► Rate Limiter (1 token) ─► executeWithFailover(group)
    │
    ├─ PRIMARY circuit admission ──rejected──► reason=CIRCUIT_OPEN ─┐
    ├─ primary bounded retry loop ──► record ONE outcome            │
    │        │                                                      │
    │        ├─ success ──────────────► respond (occurred:false)    │
    │        ├─ NOT eligible failure ─► respond original error      │
    │        └─ eligible failure ─────► reason=TIMEOUT/HTTP_50x ────┤
    │                                                               ▼
    │                              FAILOVER DECISION (all must pass)
    │                               ├─ budget remaining?        (max 1 move off primary)
    │                               ├─ fallback exists & ≠ tried?
    │                               ├─ monitor says healthy?    (strict; unknown ⇒ no)
    │                               └─ fallback circuit admits? (else reason stays CIRCUIT_OPEN)
    │                                                               │
    └─ forward-only iteration: a provider is NEVER revisited ◄──────┘
                                            │
                        fallback bounded retries ──► respond (+failover metadata)
```

Loop-freedom is **structural**, not enforced by counters: iteration strictly
advances through `group.providers`, so a request can never revisit a provider
regardless of how failures combine.

### What triggers failover (and what never does)

| Final primary outcome | Fail over? | Rationale |
| --- | --- | --- |
| per-attempt timeout | YES | another provider may be fast |
| network failure (`unreachable`) | YES | classic availability loss |
| upstream HTTP 502 / 503 / 504 | YES | transient gateway-class conditions |
| primary circuit OPEN (pre-check reject) | YES | fail fast past the dead dependency |
| any HTTP 4xx (400/401/403/404…) | NEVER | identical request ⇒ identical rejection elsewhere too |
| HTTP 500 & other 5xx | NEVER | deterministic bug — blindly failing over every 5xx just replicates it |
| non-JSON response | NEVER | possible permanent contract break |

This classifier (`isFailoverEligible`) deliberately mirrors the retry/circuit
transient sets but lives as a separate named function: the circuit asks *"did
this hurt the dependency?"*, failover asks *"could an equivalent provider do
better?"*. Today the answers coincide; coupling them would leak future policy
changes across concerns.

### Budget and gates

- **Failover budget = 1** per logical request (`DEFAULT_MAX_FAILOVERS`):
  primary + at most ONE fallback attempt, however many providers exist and
  whichever way the primary failed (executed failure or admission rejection).
- Fallback gates, in order: budget → monitor health (`isHealthy()`, strict
  `healthy`; `unknown` at boot ⇒ ineligible) → circuit admission.
- The PRIMARY is never health-gated — a stale "unhealthy" probe snapshot must
  not silently bypass it; its breaker alone decides admission.
- Each executed provider records exactly ONE outcome into ITS OWN breaker.
  Skipped providers (gated) record nothing — rejections are not failures.
- `failoverReason` captures why we LEFT the primary and is never rewritten by
  later fallback outcomes.

### Interactions with the other mechanisms

| Mechanism | Interaction |
| --- | --- |
| Rate limiting | One token per client request; failover happens inside that same request. |
| Retries | Each provider runs the full bounded retry loop independently; budget guards compose (per-provider attempts × at most 2 providers). |
| Circuit breakers | Per-provider state; primary rejection itself never counts as a failure, but its cause was already counted when recorded. Fallback failures accumulate on the FALLBACK's circuit only. |
| Health monitor | Gates fallback selection only; observability elsewhere. Monitor probes are still not request outcomes. |

### Response metadata

Every group success carries a top-level block:

```json
// normal
{ "status": "success", "data": { "...": "..." },
  "failover": { "occurred": false, "selectedProvider": "ai-primary" } }

// failed over
{ "status": "success", "data": { "...": "..." },
  "failover": { "occurred": true, "primary": "ai-primary",
                "selectedProvider": "ai-fallback", "reason": "UPSTREAM_TIMEOUT" } }
```

Error envelopes name the provider that ACTUALLY served the failed attempt in
`error.service` and embed the same failover context under
`error.upstream.failover` when one occurred. When nothing could be attempted
at all (primary rejected AND every fallback gated), the client receives the
classic `503 CIRCUIT_OPEN` envelope enriched with the per-provider skip trace
(`error.upstream.attempts`) — the root cause facing the client is the open
circuit, not the gating details.

### Observability

One summary line per logical request — warn-level when a failover happened:

```json
{"message":"proxy_failover","context":{"requestId":"9bf454b4…","group":"ai",
 "primaryProvider":"ai-primary","selectedProvider":"ai-fallback",
 "failoverOccurred":true,"failoverReason":"UPSTREAM_TIMEOUT",
 "primaryDurationMs":3007,"fallbackDurationMs":811,"totalDurationMs":3820,
 "primaryAttempts":1,"fallbackAttempts":1,
 "attempts":[{"provider":"ai-primary","attempted":true,"outcomeKind":"timeout"},
             {"provider":"ai-fallback","attempted":true,"outcomeKind":"success"}]}}
```

Non-failover requests log the same shape at info as `proxy_failover_summary`,
including skip records (`skipReason: BUDGET_EXHAUSTED | UNHEALTHY |
CIRCUIT_OPEN`).

### Limitations

- In-memory policy per gateway instance (same distributed caveats as rate
  limiting and circuits).
- One fallback level today; deeper chains would extend `providers[]` and the
  budget constant — the algorithm already iterates generically.
- The health gate reads the monitor's snapshot (up to one probe interval
  stale); the first boot round runs immediately, bounding the unknown window.

## Health monitoring

- Probes each `baseUrl + healthPath` every `HEALTH_CHECK_INTERVAL_MS`
  (default 5000 ms), per-probe deadline `UPSTREAM_TIMEOUT_MS`.
- A service counts as healthy only when it answers HTTP 200 **and** its body
  reports `"status": "healthy"` (the simulators report unhealthy-in-body
  while switched offline).
- Tracked per service: `status` (`healthy | unhealthy | unknown`),
  `latencyMs`, `lastCheckedAt`, `consecutiveFailures`, `lastError`.
- Rounds never overlap (an in-flight round skips the next tick).
- Logs state *transitions* at info level; steady-state at debug.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | 4000 | Gateway port |
| `HEALTH_CHECK_INTERVAL_MS` | 5000 | Probe interval |
| `UPSTREAM_TIMEOUT_MS` | 3000 | Hard per-attempt upstream deadline → 504 |
| `RETRY_MAX_ATTEMPTS` | 3 | Attempts incl. the initial request (1-10) |
| `RETRY_BASE_DELAY_MS` | 100 | First backoff delay, doubles per attempt |
| `RETRY_MAX_DELAY_MS` | 1000 | Cap for any single computed delay |
| `RETRY_TOTAL_BUDGET_MS` | 10000 | Wall-clock ceiling incl. all retries |
| `RATE_LIMIT_CAPACITY` | 20 | Token bucket size per client |
| `RATE_LIMIT_REFILL_RATE` | 10 | Tokens refilled per second |
| `RATE_LIMIT_CLEANUP_INTERVAL_MS` | 60000 | Inactive-bucket sweep interval |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | 5 | Consecutive failed logical requests → OPEN |
| `CIRCUIT_BREAKER_OPEN_DURATION_MS` | 10000 | Cool-off before HALF_OPEN probes |
| `CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS` | 1 | Concurrent recovery probes |
| `PAYMENT_SERVICE_URL` | http://localhost:4101 | Override registry default |
| `AI_SERVICE_URL` | http://localhost:4102 | Override ai-primary registry default |
| `AI_FALLBACK_SERVICE_URL` | http://localhost:4104 | Override ai-fallback registry default |
| `NOTIFICATION_SERVICE_URL` | http://localhost:4103 | Override registry default |

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Gateway liveness |
| GET | `/` | Service metadata + endpoint map |
| GET | `/api/services` | Health + circuit snapshot of all registered providers |
| POST | `/api/services/check` | Force an immediate probing round |
| GET | `/api/payment/test` | Proxy → payment (singleton group) |
| GET | `/api/ai/test` | Proxy → ai group: ai-primary, failover → ai-fallback |
| GET | `/api/notification/test` | Proxy → notification (singleton group) |

`GET /api/services` example:

```json
{
  "summary": { "total": 4, "healthy": 4, "unhealthy": 0, "unknown": 0 },
  "services": [
    {
      "name": "payment",
      "displayName": "payment-service",
      "baseUrl": "http://localhost:4101",
      "status": "healthy",
      "latencyMs": 4.2,
      "lastCheckedAt": "2026-08-23T23:31:02.000Z",
      "consecutiveFailures": 0,
      "lastError": null,
      "circuit": { "state": "CLOSED", "failureCount": 0, "openedAt": null }
    }
  ]
}
```

Gateway error envelope (example: timeout on the primary, served by the
fallback):

```json
{
  "success": false,
  "error": {
    "code": "UPSTREAM_TIMEOUT",
    "message": "Upstream ai-primary did not respond within 3000ms.",
    "statusCode": 504,
    "requestId": "f3f50569-c635-4a00-b393-e1f5b0c5b01c",
    "service": "ai-primary",
    "upstream": {
      "timeoutMs": 3000,
      "durationMs": 3007.65,
      "failover": { "occurred": true, "primary": "ai-primary",
                    "selectedProvider": "ai-fallback", "reason": "UPSTREAM_TIMEOUT" }
    }
  }
}
```

## Getting started

Prerequisites: Node.js >= 20. Start the simulators first (see
[`../services`](../services/README.md)), then:

```bash
cd backend
npm install
npm run dev          # development, watch mode
# or: npm run build && npm start
```

## Test scenarios (all verified live)

> **Step 7 note:** the examples below predate the failover group. Against
> `/api/ai/test` a failing primary now transparently fails over to
> `ai-fallback`, so to reproduce single-provider failure semantics use
> `/api/payment/test` (singleton group) — swap `4102` → `4101` in the chaos
> commands.

```bash
# TEST 1 - Normal: gateway -> AI -> success (~800ms)
curl http://localhost:4000/api/payment/test

# TEST 2 - Health: all four services reported healthy
curl http://localhost:4000/api/services

# TEST 3 - Slow upstream: payment answers in 5s, gateway cuts off at 3s
curl -X POST http://localhost:4101/simulation/config \
     -H "Content-Type: application/json" -d '{"latencyMs": 5000}'
curl -i http://localhost:4000/api/payment/test     # HTTP 504 after ~3000ms
curl -X POST http://localhost:4101/simulation/config \
     -H "Content-Type: application/json" -d '{"latencyMs": 800}'

# TEST 4 - Offline upstream: controlled error, process stays up
curl -X POST http://localhost:4101/simulation/config \
     -H "Content-Type: application/json" -d '{"online": false}'
curl -i http://localhost:4000/api/payment/test     # 503 UPSTREAM_UNAVAILABLE
curl http://localhost:4000/api/services            # payment flips unhealthy
curl -X POST http://localhost:4101/simulation/reset

# TEST 5 - Request ID: client id reused end-to-end
curl -i -H "X-Request-ID: demo-123" http://localhost:4000/api/payment/test
#   -> response header: X-Request-ID: demo-123
#   -> logs contain "requestId":"demo-123","requestIdSource":"client"
```

Hard-failure bonus (kill a simulator process): proxied calls still return a
controlled 503 with `ECONNREFUSED` details while the monitor increments
`consecutiveFailures`; restarting the service flips health back and resets
the counter. On the ai group this scenario now ends in a successful fallback
response instead — that is failover working as designed.

### Retry test suite (Step 4, all verified live)

> Same Step 7 caveat: run these against `/api/payment/test` + simulator
> `:4101`; on `/api/ai/test` an exhausted retry loop now fails over.

```bash
# TEST 1 - Normal payment service: 1 attempt, 0 retries, no retry metadata
curl -i http://localhost:4000/api/payment/test

# TEST 2 - Transient 503s at 50%: mix of immediate / retried-then-ok / exhausted
curl -X POST http://localhost:4101/simulation/config \
     -H "Content-Type: application/json" \
     -d '{"failureRate": 50, "failureStatus": 503}'
for i in $(seq 1 15); do curl -s http://localhost:4000/api/payment/test | \
     grep -o '"retry":{[^}]*}' || echo "no-retry"; done
curl -X POST http://localhost:4101/simulation/reset

# TEST 3 + 5 - Always 503: max attempts reached, then controlled failure
curl -X POST http://localhost:4101/simulation/config \
     -H "Content-Type: application/json" \
     -d '{"failureRate": 100, "failureStatus": 503}'
curl -i http://localhost:4000/api/payment/test
#   -> HTTP 503 after ~2.6s, error.upstream.retry.attempts = 3

# CLASSIFICATION PROOF - same rate with HTTP 500: never retried
curl -X POST http://localhost:4101/simulation/config \
     -H "Content-Type: application/json" \
     -d '{"failureRate": 100, "failureStatus": 500}'
curl -i http://localhost:4000/api/payment/test   # single attempt, UPSTREAM_ERROR
curl -X POST http://localhost:4101/simulation/reset

# TEST 4 - Latency > timeout: EVERY attempt times out (~9.3s total)
curl -X POST http://localhost:4101/simulation/config \
     -H "Content-Type: application/json" -d '{"latencyMs": 4000}'
time curl -i http://localhost:4000/api/payment/test   # 504, attempts = 3
curl -X POST http://localhost:4101/simulation/reset

# TEST 6 - Backoff bands visible in gateway logs:
#   attempt 1 delay in [50,100]ms, attempt 2 delay in [100,200]ms
```

Live results from the verification run:

| Test | Result |
| --- | --- |
| TEST 1 | 1 attempt logged, no `retry` metadata |
| TEST 2 (15 req) | 8 immediate, 6 retried-then-ok, 1 exhausted |
| TEST 3+5 | 503 in 2689ms, `attempts=3 retries=2`, envelope carries retry stats |
| Classification | HTTP 500 → exactly 1 attempt |
| TEST 4 | 504 in 9241ms (`totalDurationMs=9238`), 3 timeout attempts |
| TEST 6 | `delayMs=58` then `delayMs=117` — inside jitter bands, increasing |

### Failover test suite (Step 7, all verified live)

```bash
# T1 - Healthy primary: served directly, no failover
curl -s http://localhost:4000/api/ai/test | grep failover
#   -> "failover":{"occurred":false,"selectedProvider":"ai-primary"}

# T2 - Primary offline: transparent failover, client still gets 200
curl -X POST http://localhost:4102/simulation/config \
     -H "Content-Type: application/json" -d '{"online": false}'
curl -s http://localhost:4000/api/ai/test
#   -> 200, data.model ends in "-fallback",
#      "failover":{"occurred":true,"primary":"ai-primary",
#                 "selectedProvider":"ai-fallback","reason":"HTTP_503"}
curl -X POST http://localhost:4102/simulation/reset

# T3 - Primary too slow (>3000ms deadline): timeout triggers failover
curl -X POST http://localhost:4102/simulation/config \
     -H "Content-Type: application/json" -d '{"latencyMs": 4000}'
time curl -s http://localhost:4000/api/ai/test     # ~4s total, reason UPSTREAM_TIMEOUT
curl -X POST http://localhost:4102/simulation/reset

# T4 - Client error never fails over: fallback receives ZERO requests
curl -X POST http://localhost:4102/simulation/config \
     -H "Content-Type: application/json" -d '{"failureRate":100,"failureStatus":404,"latencyMs":50}'
curl -i http://localhost:4000/api/ai/test          # 404 passthrough, service=ai-primary

# T5 - Trip the primary's circuit while the fallback absorbs everything,
#      then verify requests skip the OPEN circuit entirely (reason CIRCUIT_OPEN)
```

Automated verification (preferred): `node scripts/e2e-failover.cjs` — boots
all four simulators + gateway and asserts all of the above plus budget,
loop-freedom and group isolation (36 checks).

Live results from the verification run:

| Scenario | Result |
| --- | --- |
| T1 primary healthy | served by `ai-primary`, `occurred:false` |
| T2 primary offline | 200 via `ai-fallback`, reason `HTTP_503`, model id proves provider |
| T3 latency 4000 > 3000 deadline | 200 via fallback in **3825 ms**, reason `UPSTREAM_TIMEOUT` |
| T4 primary 404 | 404 passthrough in 73 ms; fallback counter unchanged (before=2 after=2) |
| T5 circuit path | ai-primary OPEN at failureCount=5; next request rerouted with reason `CIRCUIT_OPEN` in 821 ms; rejection recorded nothing (count stays 5) |
| T6 both down | controlled 503 (`UPSTREAM_UNAVAILABLE`) in 10 ms — no hang, no loop |
| T7 isolation | payment 200 + CLOSED throughout the chaos |


## Project structure (gateway additions)

```
backend/src/
├── config/
│   ├── env.ts                  # + HEALTH_CHECK_INTERVAL_MS, UPSTREAM_TIMEOUT_MS, RETRY_*, service URLs
│   └── services.config.ts      # THE registry — registrations + PROVIDER_GROUPS (topology truth)
├── services/
│   ├── serviceRegistry.ts      # typed runtime access over registrations
│   ├── healthMonitor.service.ts# probe loop + snapshots + transition logging + isHealthy()
│   ├── upstreamClient.service.ts # fetch wrapper: timeout + outcome classification
│   ├── retryPolicy.service.ts  # policy data: defaults, retryable statuses, idempotency guard
│   ├── retry.service.ts        # generic executor: backoff+jitter, budget guard, hooks
│   ├── rateLimiter.service.ts  # token bucket: refill-from-elapsed-time + headers
│   ├── circuitBreaker.service.ts # per-provider state machine: CLOSED/OPEN/HALF_OPEN
│   ├── failover.service.ts     # provider-group orchestrator: gates, budget=1, metadata
│   └── proxy.service.ts        # one reusable proxy mechanism (wraps retry executor)
├── controllers/
│   └── gateway.controller.ts   # list/refresh services + per-GROUP proxy handler factory
├── routes/
│   │   service.routes.ts       # /api/services (+ /check) — merged health+circuit view
│   └── proxy.routes.ts         # generated from PROVIDER_GROUPS
├── scripts/                    # node:test unit tests + live E2E harnesses (not in build)
└── types/index.ts              # ServiceRegistration, ProviderGroup, FailoverMetadata, ...
```

> Windows note: npm `.bin` shims break under paths containing `&` — scripts
> invoke tools through `node` directly (see package.json).

## Roadmap

1. ~~**Phase 4** — retry with exponential backoff + jitter (idempotent routes).~~ DONE
2. ~~**Phase 5** — circuit breaker per service (CLOSED/OPEN/HALF_OPEN).~~ DONE
3. ~~**Phase 6** — rate limiting per client/service.~~ DONE
4. ~~**Phase 7** — automatic failover across provider pools.~~ DONE
5. **Phase 8** — metrics pipeline, incident timeline persistence.
6. **Phase 9** — ML anomaly detection on latency/error streams.
7. **Phase 10** — React dashboard: light/dark theme, live topology, chaos panel.

## Testing

```bash
npm test                              # unit: node:test runner, zero new deps (34 tests)
npm run build                         # tsc production build
node scripts/e2e-circuit-breaker.cjs # live E2E: breaker state machine on payment (~40s)
node scripts/e2e-failover.cjs        # live E2E: failover scenarios on the ai group (~30s)
```

Unit tests cover the breaker state machine with an injected fake clock
(threshold tripping, fail-fast cost, lazy OPEN→HALF_OPEN, single-probe guard,
both recovery paths, isolation), the token bucket scenarios from Step 5, and
the failover orchestrator with a scripted executor seam (classification table,
budget exhaustion across a three-provider group, circuit-open skip without
contact, health gating, non-eligible stop, per-provider outcome isolation).

The E2E harnesses spawn all simulators + gateway, drive real traffic, and
assert statuses, timing, `/api/services` circuit fields and simulator request
counters; they refuse to start if any expected port is still occupied.
