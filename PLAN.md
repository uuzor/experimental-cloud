# AI Copy-Trading Signal Platform — V1 Backend Development Doc

**Scope:** Backend only. No frontend. One venue (Hyperliquid). One signal type (on-chain top-trader tracking). Flat subscription billing, no performance fees. Goal is a working, safe, observable end-to-end pipeline — not the full multi-venue/multi-signal marketplace from the original concept.

---

## 0. V1 Boundaries (read this before building anything)

**In scope:**
- One signal source type: automated tracking of a curated list of top-performing Hyperliquid wallets, emitting position-change events.
- One execution venue: Hyperliquid perps, via agent wallets.
- One billing model: flat monthly subscription (fiat via Stripe or stablecoin deposit), no AUM-linked or performance fees.
- Zeabur as the container host for per-user execution agents.
- A single LLM touchpoint: signal *filtering/annotation* only (e.g. "does this signal match the user's configured risk profile"), never signal *generation* and never a fully autonomous decision loop.

**Explicitly out of scope for v1** (see §18 for the full deferred list): performance-fee billing, multi-venue support, news/chart LLM signal generation, signal-provider marketplace/discovery UI, multi-LLM BYO-key routing, OKX or CEX integration, mobile app, public API for third-party signal providers.

**Why this matters:** every section below is written to this narrow scope on purpose. Resist the urge to generalize early — the generalized version is v2, after this loop is proven with real (small) money and nothing has silently failed.

---

## 1. Why Hyperliquid for V1

- **Agent wallets (API wallets)** are L1-action-only signers — they can place/cancel/modify orders but structurally cannot withdraw or transfer funds. This is the core safety property the whole custody model depends on: a compromised execution container can produce bad trades, never a drained account.
- **Public, unauthenticated Info API + WebSocket feeds** make wallet tracking (the v1 signal source) free and straightforward — no permission negotiation needed to read positions.
- **Builder fee support** (`builder: { b: <address>, f: <fee> }` on order placement) gives a native, on-chain way to attribute a small platform fee per trade later, without a separate billing rail — useful for v2, not required for v1's flat subscription.
- Tradeoff to design around: **no dedicated perpetuals testnet for full simulation** — testnet exists for API mechanics but isn't a reliable proxy for real fill/slippage behavior. All new logic must go through a small-size mainnet soak period before scaling position size (see §17).

---

## 2. High-Level Architecture

```
                         ┌────────────────────────────┐
                         │   Signal Tracker Service    │
                         │  (single Zeabur service,    │
                         │   polls Hyperliquid Info API│
                         │   + WS for tracked wallets)│
                         └──────────────┬─────────────┘
                                        │ publish position-change events
                                        ▼
                         ┌────────────────────────────┐
                         │   Redis Streams (Pub/Sub)   │
                         │   channel: signals:v1       │
                         └──────────────┬─────────────┘
                                        │ fan-out
              ┌─────────────────────────┼─────────────────────────┐
              ▼                         ▼                         ▼
      ┌───────────────┐        ┌───────────────┐        ┌───────────────┐
      │ Execution      │        │ Execution      │        │ Execution      │
      │ Agent (user A) │        │ Agent (user B) │        │ Agent (user N) │
      │ Zeabur container│       │ Zeabur container│       │ Zeabur container│
      │ own HTTP API + │        │ own HTTP API + │        │ own HTTP API + │
      │ own HL client   │        │ own HL client   │        │ own HL client   │
      └───────┬───▲────┘        └───────┬───▲────┘        └───────┬───▲────┘
              │   │ control calls        │   │                     │   │
              │   │ (pause/resume/       │   │                     │   │
              │   │  flatten/config)     │   │                     │   │
   telemetry ─┘   └──────────┐          │   │                     │   │
   (heartbeat,               │          │   │                     │   │
    fills, errors)           │          │   │                     │   │
              └───────────────┴──────────┴───┴─────────────────────┴───┘
                                        ▼         ▲
                         ┌────────────────────────────┐
                         │   Core Backend API          │
                         │  (auth, provisioning,       │
                         │   billing, telemetry, DB,   │
                         │   agent control client)     │
                         └──────────────┬─────────────┘
                                        ▼
                              ┌──────────────────┐
                              │ Postgres (primary)│
                              │ Redis (cache/queue)│
                              └──────────────────┘
```

One signal tracker service (not per-user) is enough for v1 — you're watching a shared curated wallet list, not per-user custom sources. This alone removes a huge amount of the "1-to-many broadcast" complexity from the original concept, since there's exactly one publisher.

**Three separate codebases, three separate concerns:**

| Codebase | Location | What it does | Lives where |
|----------|----------|--------------|-------------|
| `backend` | Core API repo | Auth, billing, provisioning, DB, telemetry, agent control client | Single instance |
| `execution-agent` | Per-user container repo | Consumes signals, places orders, risk filtering, LLM gate | One per user (Zeabur container) |
| `signal-tracker` | Single service repo | Polls Hyperliquid, emits signals | Single instance |

The backend never runs trading logic; the execution agent never touches the primary database or billing. The signal tracker owns all reads from Hyperliquid's Info API and is the only service that writes to the `signals` table and Redis Stream. The only things that cross these boundaries are:
- Agent → backend: telemetry/handshake calls
- Backend → agent: control calls (pause/resume/flatten/config)
- Signal tracker → Redis Stream: signal events (consumed by agents)

---

## 3. Database Schema (Postgres)

```sql
-- Users
CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT UNIQUE NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  subscription_status TEXT NOT NULL DEFAULT 'inactive', -- inactive | active | past_due | canceled
  stripe_customer_id TEXT,
  timezone          TEXT DEFAULT 'UTC'
);

-- Hyperliquid credentials — only ever the AGENT (API) wallet, never a master key
CREATE TABLE hl_agent_wallets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_address     TEXT NOT NULL,       -- public address of the agent wallet
  agent_name        TEXT NOT NULL,       -- named agent, per Hyperliquid's approveAgent
  encrypted_agent_key TEXT NOT NULL,     -- envelope-encrypted private key of the AGENT wallet only
  master_address    TEXT NOT NULL,       -- user's master account address (read-only reference, never signs)
  registered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  status            TEXT NOT NULL DEFAULT 'active', -- active | revoked | expired
  UNIQUE (user_id)
);

-- Tracked top-trader wallets (curated signal source list — admin managed in v1)
CREATE TABLE tracked_wallets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address           TEXT UNIQUE NOT NULL,
  label             TEXT,                 -- optional display name
  added_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  active            BOOLEAN NOT NULL DEFAULT true
);

-- Raw signal events emitted by the tracker service
CREATE TABLE signals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_wallet_id UUID NOT NULL REFERENCES tracked_wallets(id),
  asset             TEXT NOT NULL,
  side              TEXT NOT NULL,        -- LONG | SHORT | CLOSE
  size_delta        NUMERIC NOT NULL,
  leverage          NUMERIC,
  entry_price       NUMERIC,
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload       JSONB NOT NULL
);

-- User execution agent config (maps 1:1 to a Zeabur service)
CREATE TABLE execution_agents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  zeabur_service_id TEXT,                 -- null until provisioned
  zeabur_project_id TEXT,
  agent_internal_url TEXT,                -- Zeabur internal networking address (host:port) for the agent's own API
  agent_control_token_hash TEXT,          -- hash of the token the backend presents when calling INTO the agent
  status            TEXT NOT NULL DEFAULT 'provisioning', -- provisioning | active | disconnected | suspended | terminated | paused
  max_position_usd  NUMERIC NOT NULL,      -- hard cap per trade, user-set
  max_leverage      NUMERIC NOT NULL DEFAULT 3,
  daily_loss_limit_usd NUMERIC,            -- optional kill-switch threshold
  llm_filter_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat_at TIMESTAMPTZ
);

-- Executions resulting from signals (append-only audit trail)
CREATE TABLE executions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_agent_id UUID NOT NULL REFERENCES execution_agents(id),
  signal_id         UUID REFERENCES signals(id),
  hl_order_id       TEXT,
  asset             TEXT NOT NULL,
  side              TEXT NOT NULL,
  size              NUMERIC NOT NULL,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  filled_at         TIMESTAMPTZ,
  fill_price        NUMERIC,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | filled | rejected | error
  error_detail      TEXT,
  jitter_ms_applied  INTEGER
);

-- Heartbeats (rolling — can be pruned/partitioned aggressively)
CREATE TABLE agent_heartbeats (
  id                BIGSERIAL PRIMARY KEY,
  execution_agent_id UUID NOT NULL REFERENCES execution_agents(id),
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  status            TEXT NOT NULL             -- ok | degraded | error
);

-- Billing (flat subscription — Stripe is source of truth, this is a local mirror)
CREATE TABLE subscriptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT UNIQUE,
  plan              TEXT NOT NULL DEFAULT 'v1_flat',
  status            TEXT NOT NULL,
  current_period_end TIMESTAMPTZ
);

-- Audit log — every privileged action (provision, suspend, credential rotation)
CREATE TABLE audit_log (
  id                BIGSERIAL PRIMARY KEY,
  actor             TEXT NOT NULL,          -- user_id, 'system', or admin id
  action            TEXT NOT NULL,
  target_type       TEXT NOT NULL,
  target_id         TEXT,
  detail            JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Notes:
- `executions` is intentionally append-only and never updated in place beyond status/fill fields — this is your regulatory and dispute-resolution paper trail.
- `tracked_wallets` is admin-curated in v1, not user-submitted. User-submitted wallet tracking is a v2 feature with its own abuse/validation surface.
- Partition `agent_heartbeats` by day or move to a TTL'd store (Redis with expiry, or Postgres partitioned table) early — this table grows fast and doesn't need to live in your primary OLTP path long-term.

---

## 4. Signal Tracker Service

Single long-running Zeabur service (not spun up per user). Its own standalone codebase from day one.

### 4.1 Internal Repo Structure

```
signal-tracker/
  src/
    index.js              # entry point, wires everything together
    hyperliquid/
      restClient.js       # REST polling (fallback/reconciliation)
      wsClient.js         # WebSocket subscription (primary real-time feed)
      rateBudget.js       # local weight-budget tracker against Hyperliquid limits (§8)
    detector/
      walletState.js      # tracks last-known positions per wallet
      changeDetector.js   # diffs current vs last state, emits signals on meaningful change
    publisher/
      signalWriter.js     # writes to Postgres signals table
      redisPublisher.js   # publishes to Redis Stream signals:v1
    scheduler/
      pollScheduler.js    # cron-like interval for REST reconciliation fallback
    heartbeat.js          # periodic heartbeat to core backend
    config.js             # loads tracked wallet list, env vars
  package.json
  Dockerfile / zeabur template spec
```

**Key design decisions:**
- WebSocket is the primary feed (lower latency); REST polling is only a reconciliation fallback (runs every 5 minutes by default) in case WS missed an update.
- `walletState.js` holds an in-memory Map of `address → lastKnownPosition[]` — lightweight since it's tracking a curated list, not thousands of wallets.
- `changeDetector.js` uses a simple threshold: emit signal if position size changes by >5% or direction flips (LONG→SHORT or vice versa) or position opened/closed. Threshold is configurable, not hardcoded.
- No LLM, no complex analytics — this is pure signal extraction, not signal generation.

### 4.2 Signal Emission Rules

A signal is emitted when:

| Event | Condition |
|-------|-----------|
| New position opened | Any non-zero position where previous was zero |
| Position size increased | Size delta >5% of previous size |
| Position size decreased | Size delta >5% of previous size (both increase and decrease emit) |
| Position closed | Position goes from non-zero to zero |
| Direction flipped | Side changes from LONG to SHORT or vice versa |

**Noise threshold:** The 5% size delta threshold filters out micro-rebalances. Adjustable via `SIGNAL_MIN_SIZE_CHANGE_PCT` env var.

### 4.3 Communication with Backend

- **Outbound only:** signal tracker calls the backend, never receives calls from it.
- **Heartbeat:** POSTs to `BACKEND_URL/v1/internal/signal-tracker/heartbeat` every 30s.
- **On signal emit:** writes to Postgres + publishes to Redis Stream independently — if Redis is temporarily down, Postgres is the fallback and a reconciliation job can republish later.

### 4.4 Zeabur Deployment

Unlike the execution agent (which is provisioned per-user via the backend's Zeabur provisioner), the signal tracker is a **single static deployment**. It can be:
- Deployed via Zeabur's dashboard or CLI pointing at the `signal-tracker/` repo
- Or managed programmatically via the backend's Zeabur client if you want it fully infrastructure-as-code

Env vars injected at deploy time:
- `HYPERLIQUID_API_URL` — info API endpoint
- `POSTGRES_URL` — direct DB connection for writing signals
- `REDIS_URL` — for publishing to `signals:v1`
- `BACKEND_URL` — for heartbeat calls
- `TRACKED_WALLETS` — JSON array of wallet addresses to watch (can be updated without redeploy via config refresh)

---

## 5. Pub/Sub & Distribution

**Redis Streams**, not raw Pub/Sub, for v1 — you want consumer groups, replay/ack semantics, and at-least-once delivery, none of which vanilla Redis Pub/Sub gives you. (NATS is a fine alternative if you're already comfortable with it; Redis Streams is the lower-friction choice given Postgres/Redis are already in the stack.)

- Single channel/stream for v1: `signals:v1`. No per-provider channel complexity needed since there's one signal source.
- Each execution agent container runs a consumer in its own consumer group, so a container restart resumes from its last-acked position rather than missing signals during a redeploy.
- **Auth:** execution agents authenticate to Redis using a short-lived token minted by the core backend at boot (see §9, heartbeat/handshake), scoped read-only to `signals:v1`. Containers never get long-lived Redis credentials baked into their image.

---

## 6. Execution Agent (per-user Zeabur container)

Each user's execution agent is its **own standalone Node.js service** — a separate codebase/package from the core backend, with its own internal HTTP API and its own module for talking to Hyperliquid. The backend provisions it and controls it at arm's length; it never imports backend code or shares a runtime with it.

**Boot sequence:**
1. Container starts with env vars injected by the backend at provision time: `AGENT_ID`, `USER_ID`, `PLATFORM_API_KEY` (used for the agent's outbound calls to the backend), `AGENT_CONTROL_TOKEN` (used to authenticate the backend's inbound calls to *this* agent — see §6.2), `BACKEND_TELEMETRY_URL`.
2. First action: call the backend's `/v1/agents/handshake` endpoint to (a) confirm liveness, (b) fetch its Redis stream token, (c) fetch its current risk config (`max_position_usd`, `max_leverage`, `daily_loss_limit_usd`) — config is fetched at boot and on a periodic refresh, **not** baked into the image, so a user can update risk limits without a redeploy.
3. Second action: start its own local HTTP server (§6.2) so the backend can reach it directly, then register its reachable address back to the backend (`agent_internal_url`) as part of the handshake response.
4. On successful handshake, status flips `provisioning → active` in `execution_agents`, dashboard reflects this via the backend (not covered here, frontend excluded).

### 6.1 Internal Repo Structure

Keep the agent as a genuinely separate, minimal package — this is what lets you redeploy/version it independently of the backend, and what makes the Zeabur worker image simple to build:

```
execution-agent/
  src/
    server.js            # small HTTP server exposing the agent's own API (§6.2)
    hyperliquid/
      client.js           # thin wrapper: signing, order placement, account state, nonce mgmt
      rateBudget.js        # local weight-budget tracker against Hyperliquid limits (§8)
    signals/
      consumer.js          # Redis Streams consumer group logic
      riskFilter.js         # deterministic static rule checks (§6, runtime loop steps 2-3)
      llmFilter.js           # optional LLM pass/fail annotation (§10), only if llm_filter_enabled
    execution/
      orderRunner.js         # jitter + submit + telemetry post
      circuitBreaker.js       # daily loss limit tracking, self-suspend logic
    telemetry.js             # heartbeat + execution/error reporting to backend
    config.js                # loads env vars, periodic config refresh from backend
  package.json
  Dockerfile / zeabur template spec
```

Nothing in `hyperliquid/client.js` or `execution/` ever imports anything backend-specific — it only knows its own `AGENT_ID`, its own Hyperliquid credentials, and the Redis/backend URLs it was given at boot. This is what makes it deployable as a standalone unit per user.

### 6.2 The Agent's Own API (backend calls IN)

This is the missing half of the original design: the backend needs a way to reach a *specific* agent directly, without going through Zeabur's container-level `suspendService` (which is a blunt, whole-container action). The agent exposes a small internal-only HTTP API, reachable at `agent_internal_url`, authenticated by `AGENT_CONTROL_TOKEN` (checked against `agent_control_token_hash` — the raw token is only ever known by the agent and the backend, never logged).

```
GET    /internal/health                — liveness + current internal state snapshot
POST   /internal/pause                 — stop consuming new signals, keep existing positions open, process stays alive
POST   /internal/resume                — resume signal consumption after a pause
POST   /internal/config                — push an updated risk config immediately (bypasses the agent's own poll interval)
POST   /internal/flatten               — close all open positions immediately via Hyperliquid, then auto-pause
GET    /internal/state                 — current open positions, last N executions, current loss-limit usage
```

This gives you three distinct control tiers, from softest to hardest:
1. **`/internal/pause`** — soft stop, no container disruption, instant. Use this for routine "user hit their configured limit" or "user wants to pause for the weekend" cases.
2. **`/internal/flatten`** — closes real positions, still no container disruption. Use this for the "something is wrong and we need exposure gone now" case — this is the piece the original circuit-breaker design was missing, since a container suspend alone doesn't close open positions.
3. **Zeabur `suspendService`** (§7) — nuclear option, whole container down. Reserved for cases where the agent process itself is unresponsive or compromised and even its own API can't be trusted to respond correctly.

The backend's `ZeaburProvisioner`/agent-control client should attempt tier 1 or 2 first and only fall back to tier 3 if the agent's own API doesn't respond within a short timeout — an unresponsive agent is exactly the case where you also want the Zeabur-level kill switch as a backstop.

### 6.3 Hyperliquid Client Module (`hyperliquid/client.js`)

This is the agent's only path to Hyperliquid — nothing else in the agent, and nothing in the backend, talks to Hyperliquid directly. Keeping it as one small, well-tested module (rather than scattered `fetch` calls) is what makes nonce handling and rate-budget tracking reliable.

Responsibilities:
- **Signing:** loads the agent wallet's private key (decrypted once at boot from the value the backend injected, held only in memory, never written to disk) and produces the phantom-agent / EIP-712 signatures Hyperliquid's Exchange API requires.
- **Nonce management:** tracks its own last-used nonce locally (Hyperliquid keeps the 100 highest nonces per signer server-side) and generates the next valid one per call — this must live here, not in the backend, since nonces are per-signer and the signer only exists inside this container.
- **Order placement:** wraps `order` / `bulk_orders` / `market_order` with the agent's `AGENT_ID` implicitly attached for correlation in telemetry, and supports the `builder` fee field for later use (currently unused in v1's flat-subscription billing, but wired so v2 doesn't require a rewrite).
- **Account state:** wraps `clearinghouseState` queries for the agent's own position/margin state — used by `circuitBreaker.js` and by `/internal/state`, never used to poll other users' or other wallets' data (that's the signal tracker's job, §4, and stays out of this module entirely).
- **Rate budget awareness:** every call increments a local counter checked against `rateBudget.js` before firing, so a single misbehaving agent can't blow through Hyperliquid's per-address weight budget (§8) — it self-throttles rather than relying on the 429 as the first line of defense.

### 6.4 Concrete Stack & Packages

Zeabur itself is stack-agnostic — it auto-detects and runs whatever you push (Node.js, Python, Go, etc.), it isn't opinionated about what's inside the container. So the stack below is a deliberate choice for *this* agent, not something Zeabur imposes.

**Runtime: Node.js (TypeScript), not Python.** Reasoning, not just default habit:
- The most complete, actively maintained Hyperliquid SDK is TypeScript-first (`@nktkas/hyperliquid` — 100% typed, wraps signing/transport/nonce mechanics, supports both HTTP and WebSocket transports). The Python SDK exists but has less API surface coverage.
- This is an I/O-bound service (waiting on Redis, HTTP calls, WebSocket events) with no heavy numerical computation — Node's event loop is a good fit; there's no data-science workload here that would pull toward Python.
- Keeping backend and agent both on Node.js means one language, one set of tooling conventions, shared mental model — worth something even though the two are genuinely separate codebases.

**Core packages:**

| Purpose | Package | Notes |
|---|---|---|
| Hyperliquid client | `@nktkas/hyperliquid` | Requires Node ≥22.12. If Zeabur's runtime image pins an older Node, use the drop-in fork `@deeeed/hyperliquid-node20` (Node ≥20.18, identical API) instead of fighting the version. |
| Wallet/signing | `viem` | `privateKeyToAccount()` turns the decrypted agent key into the account object the Hyperliquid SDK's `ExchangeClient` expects. |
| Internal HTTP API | `fastify` | Small, low-overhead, built-in schema validation — good fit for a handful of internal-only routes (§6.2). Express is a fine substitute if you'd rather stay in more familiar territory; the routes are simple enough that framework choice isn't a real risk either way. |
| Redis Streams | `ioredis` | Consumer group support (`XREADGROUP`/`XACK`) for the `signals:v1` consumer (§5). |
| Schema/env validation | `zod` | Validates env vars at boot (fail fast on missing `AGENT_ID` etc.), validates LLM filter output (§10) before trusting it. |
| Logging | `pino` | Structured JSON logs — matters here because Zeabur's `runtimeLogs` API is how you'll pull agent logs centrally (§7); structured logs are what makes that pipeline useful later instead of grepping text. |
| HTTP calls to backend | native `fetch` | Node 22 has it built in — no need for `axios` for the handshake/telemetry calls. |
| LLM filter calls | `openai` SDK, pointed at Zeabur AI Hub's OpenAI-compatible base URL | Reuses the official SDK's retry/typing rather than hand-rolling HTTP calls, per the AI Hub decision in §10. |
| Testing | `vitest` | Fast, TS-native, no separate ts-jest config overhead. |
| Build | `tsx` for dev, `tsc` (or `tsup` if you want a single bundled output) for the production build Zeabur runs | Keep it simple — this is a small service, not a package meant for distribution. |

**Zeabur deployment shape:** since this is a plain Node.js project (a `package.json` with a `start` script, e.g. `node dist/server.js`), Zeabur's auto-detection handles the build without a Dockerfile. The template YAML passed to `deployTemplate` (§7) needs, at minimum: the source (git repo + branch, or a pre-built image if you'd rather not expose the repo per-deploy), the run command, and the env var slots that get filled in per-user at provision time (`AGENT_ID`, `USER_ID`, `PLATFORM_API_KEY`, `AGENT_CONTROL_TOKEN`, `BACKEND_TELEMETRY_URL`, `REDIS_STREAM_URL`). Keep the template itself generic and static — all the per-user variation is in the env vars injected at call time, not in different templates per user.

**Runtime loop:**
1. Consume from `signals:v1`.
2. Apply the user's static risk filter (position size cap, leverage cap, asset allow/deny list) — deterministic, no LLM involved at this stage.
3. If `llm_filter_enabled`, pass the signal + user's stated risk preferences to the LLM filter step (§10) for a pass/fail annotation. LLM output is advisory-gating only — it can suppress a trade, it cannot invent one.
4. Apply jitter delay (§9).
5. Submit order via Hyperliquid Exchange API using the agent wallet.
6. Post execution result to `/v1/telemetry` (hot path — see §11).
7. Send heartbeat every 30s regardless of trading activity.

**Daily loss limit / circuit breaker:** the container tracks realized+unrealized PnL against `daily_loss_limit_usd` locally and self-suspends (stops consuming new signals, does not close existing positions automatically — closing positions automatically on a limit breach is a v2 decision requiring more careful design) if breached, then notifies the backend. The backend independently double-checks this from telemetry, since a compromised or buggy container shouldn't be the sole enforcer of its own kill switch.

---

## 7. Zeabur Integration Layer

Backend-side service (`ZeaburProvisioner`) wrapping Zeabur's GraphQL Public API.

**Provisioning a new execution agent:**
```graphql
mutation DeployTemplate($rawSpecYaml: String, $projectId: ObjectID) {
  deployTemplate(rawSpecYaml: $rawSpecYaml, projectID: $projectId) {
    _id
  }
}
```
- `rawSpecYaml` points at your pre-built execution-agent worker image/template, with per-user env vars merged in at call time (`AGENT_ID`, `USER_ID`, `PLATFORM_API_KEY`).
- Store the returned service id in `execution_agents.zeabur_service_id` immediately — this is your handle for all future lifecycle calls.
- Auth via Bearer token (`Authorization: Bearer <ZEABUR_API_TOKEN>`), token stored as a platform-level secret, never per-user.

**Lifecycle operations to wrap:**
- `suspendService` / restart — used by the circuit-breaker path (§6) and by the heartbeat monitor (§11) if a container goes silent.
- `runtimeLogs` subscription — pull into your own log aggregation rather than relying on users/admins tailing Zeabur's dashboard directly; you want execution logs correlated with your `executions` table.
- Teardown on subscription cancellation or user-initiated deletion — don't leave orphaned containers billing against your Zeabur account.

**Practical note on Zeabur as trading infra:** Zeabur is a general-purpose PaaS, not built with SLA guarantees for low-latency financial execution. Before onboarding real users, run a soak test: deploy 5-10 execution agents, measure container cold-start time, restart frequency, and network latency to Hyperliquid's endpoints under normal operation. If cold-start/restart latency turns out to matter more than expected for slippage, that's a decision point to revisit (dedicated VM/server tier, or Zeabur's "Servers" product instead of ephemeral containers) — better to learn this in week 2 than after users are live.

---

## 8. Rate Limits & Hyperliquid API Constraints

Hyperliquid uses a weight-based budget, not simple request counts:

- Shared budget: **1,200 weight units/minute** per address/IP context.
- Most info-endpoint queries cost ~20 weight → roughly **60 calls/minute** before hitting that budget from info queries alone.
- A separate long-term cumulative buffer exists: **1 additional request per 1 USDC traded** since account inception, starting with an initial buffer of 10,000 requests — this mostly protects active traders, but matters for exchange (write) actions specifically.
- If rate-limited, the address is throttled to **1 request per 10 seconds** until the buffer recovers — design for graceful degradation here, not a hard failure.
- Cancels get a more generous cumulative allowance (`min(limit + 100000, limit * 2)`) specifically so you can always cancel/flatten even while otherwise rate-limited — **exploit this**: your circuit breaker and any "flatten position" path should always be able to execute even under throttling.
- EVM JSON-RPC endpoint (`rpc.hyperliquid.xyz/evm`) is capped separately at 100 req/min — irrelevant to this v1 scope (no EVM interaction planned) but worth knowing if v2 adds anything EVM-side.

**Design implications:**
- The centralized signal-tracker service (§4) is the *only* thing polling wallet data — this is the single biggest rate-limit risk mitigation versus a design where every execution container independently queries Hyperliquid for market/account state. Execution containers should query Hyperliquid only to (a) check their own account state before ordering, (b) place/cancel orders — never to poll public market or other-wallet data, which the tracker already provides via the pub/sub layer.
- Track your budget in code via the `userRateLimit` info query rather than assuming — log remaining budget on every exchange-endpoint call and alert before you're close to the ceiling, not after a 429.
- WebSocket subscriptions for real-time data, REST reserved for actions and periodic reconciliation — this is both a latency and a rate-limit optimization.

---

## 9. Scheduling & Job Queues

**BullMQ (Redis-backed)** for anything that isn't a real-time reaction to a signal:

| Job | Frequency | Purpose |
|---|---|---|
| `reconcile-tracked-wallets` | every 2 min | REST fallback in case WS missed updates |
| `heartbeat-sweep` | every 1 min | flag agents with no heartbeat in >90s as `disconnected`, alert user |
| `daily-pnl-rollup` | daily | compute per-agent PnL for dashboard + loss-limit cross-check |
| `subscription-sync` | every 15 min | reconcile local `subscriptions` table against Stripe webhooks (belt & suspenders) |
| `zeabur-orphan-check` | daily | detect Zeabur services with no matching active `execution_agents` row, flag for teardown |
| `agent-key-expiry-check` | daily | Hyperliquid agent wallets can expire/be pruned — proactively warn users before their agent stops being able to sign |

Real-time signal → execution is **not** a scheduled job — it's the Redis Streams consumer loop inside each execution agent (§5, §6), reacting as messages arrive.

---

## 10. AI / LLM Usage Policy

This is the one place in v1 where an LLM touches the loop, and it's deliberately narrow:

**What the LLM does:** given a structured signal (asset, side, size, tracked wallet's historical hit rate) and the user's stated risk preferences in plain language (e.g. "I don't want to follow trades on assets I don't recognize" or "skip anything over 5x leverage even if my cap technically allows it"), return a structured pass/fail/flag decision with a short reason string.

**What the LLM never does:**
- Never generates a trade idea from scratch (news reading, chart pattern generation — explicitly deferred to v2, and only after this deterministic path has a track record).
- Never has write access to order placement directly — its output is one input into the deterministic filter chain in §6 step 3, gated the same way a static rule would be.
- Never sees or handles the agent wallet key or any credential.

**Guardrails:**
- Structured output only (JSON schema enforced, reject and fall back to "no LLM opinion, defer to static rules" on malformed output — never let a parse failure silently become an approval).
- Timeout + fallback: if the LLM call doesn't return within a short deadline, the signal proceeds through static rules only — LLM filtering is a *narrowing* layer, its absence should never block or fail a trade decision that static rules would otherwise allow.
- Every LLM filter decision is logged (`audit_log`) with the exact input/output pair — this is your debugging and compliance trail if a user disputes a skipped or executed trade.
- LLM provider: route through Zeabur's AI Hub (unified OpenAI-compatible endpoint across model providers, per-token billing) rather than building a custom multi-provider gateway — this removes an entire subsystem from v1 scope. BYO-key support is a v2 feature.

---

## 11. Telemetry, Monitoring, Alerting

**Hot path** (`/v1/telemetry`, called by execution agents on every fill/error/heartbeat):
- Writes to Postgres (`executions`, `agent_heartbeats`) and simultaneously pushes to a Redis-backed pub/sub or SSE channel for any live-viewing surface later — even with frontend excluded from this doc, keep this path wired so v2's dashboard is a pure consumer, not a backend rewrite.

**Heartbeat rule:** every execution agent pings every 30s. Three missed heartbeats (90s) → status flips to `disconnected`, triggers:
1. Email alert to the user.
2. `audit_log` entry.
3. No automatic Zeabur restart on first disconnect — auto-restart only after a second confirmation cycle, to avoid restart-looping a container that's failing for a real reason (bad credentials, exchange-side error) rather than a transient network blip.

**Error-triggered circuit breaking:** if an agent reports N consecutive execution errors (config threshold, start at 3) within a short window, the backend issues a `suspendService` call via the Zeabur provisioner and notifies the user — this is the "stop it before it does more damage" path from the original concept, now concretely wired to Zeabur's API rather than described abstractly.

---

## 12. Jitter & Execution Safety

- On receiving a signal, each execution agent applies a randomized delay before submitting its order — start with **0-250ms**, tunable.
- Purpose: with a curated wallet list (not thousands of signal sources), thundering-herd risk is much lower than the original multi-provider concept, but jitter still matters once you have more than a handful of subscribed users reacting to the same signal simultaneously.
- Jitter amount is logged per execution (`executions.jitter_ms_applied`) so you can later correlate jitter against fill price/slippage and tune it empirically instead of guessing.
- No tiered/priority queueing in v1 (the "premium users get less jitter" idea from the original concept) — single flat jitter policy for all users until you have real slippage data suggesting otherwise.

---

## 13. Security & Custody Model

- **Only the Hyperliquid agent (API) wallet private key is ever stored**, envelope-encrypted at rest (e.g. KMS-backed encryption key, never the same key across environments). The user's master wallet never touches your infrastructure.
- Agent wallets are named (`approveAgent` with a name) so they can be individually revoked/rotated without affecting other agents on the same master account.
- **Nonce handling:** Hyperliquid keeps the 100 highest nonces per signer; your execution agent must track its own nonce state carefully and never reuse an address across re-registrations — generate a fresh agent wallet on any re-registration rather than reusing.
- Agent wallets can expire or be pruned if the master account's funds drop to zero, or on re-registration under the same name — the `agent-key-expiry-check` job (§9) exists specifically to catch this before it becomes a silent execution failure.
- Zeabur-side: `PLATFORM_API_KEY` injected per container is scoped and rotatable independently of any user's trading credentials — a leaked platform key should never be sufficient on its own to move funds.
- All privileged backend actions (credential rotation, manual suspend, config override) go through `audit_log` with actor attribution — no exceptions, including admin/system actions.

---

## 14. Billing (V1: Flat Subscription Only)

- Stripe subscription, single plan (`v1_flat`), no usage-based or performance-based component.
- Stripe is the source of truth; `subscriptions` table is a local mirror kept in sync via webhook + the `subscription-sync` reconciliation job.
- Subscription status gates execution agent provisioning and continued operation: `subscription_status != 'active'` → new provisioning blocked; existing agents get a grace-period suspend (not immediate teardown) on lapse, per your own policy preference — recommend 3-7 days.
- No performance fee logic, no on-chain payment splitting, no builder-fee attribution in v1 — deliberately deferred (see §18) since performance fees are the piece most likely to trigger investment-adviser classification, and validating the deterministic execution pipeline doesn't require solving that yet.

---

## 15. Backend API Surface (v1)

```
POST   /v1/auth/login                     — user auth (session/JWT)
POST   /v1/hl-agent-wallet                — register a user's Hyperliquid agent wallet (encrypted key upload)
POST   /v1/execution-agents               — create + trigger Zeabur provisioning
GET    /v1/execution-agents/:id           — status, config, last heartbeat
PATCH  /v1/execution-agents/:id/config    — update risk limits (live-refreshed by container)
POST   /v1/execution-agents/:id/suspend   — manual suspend (user or admin initiated)
DELETE /v1/execution-agents/:id           — teardown, triggers Zeabur service deletion

POST   /v1/agents/handshake               — container boot handshake (internal, PLATFORM_API_KEY auth)
POST   /v1/telemetry                      — hot-path telemetry ingestion (internal)
GET    /v1/agents/:id/stream-token        — mint short-lived Redis stream token (internal)
```

These are all **inbound to the backend** (agent → backend). Separately, the backend holds a small **agent-control client** that calls **outbound, into each agent's own API** (`agent_internal_url`, §6.2) for pause/resume/flatten/config-push. That client lives in the backend codebase (it needs `execution_agents.agent_internal_url` and the control token), but the endpoints it calls belong to the agent, not the backend:

```
# Called BY the backend, INTO a specific running agent — not backend routes
GET    {agent_internal_url}/internal/health
POST   {agent_internal_url}/internal/pause
POST   {agent_internal_url}/internal/resume
POST   {agent_internal_url}/internal/config
POST   {agent_internal_url}/internal/flatten
GET    {agent_internal_url}/internal/state
```

Back to regular backend-facing routes:

```
GET    /v1/executions?agent_id=           — execution history for a given agent
GET    /v1/signals?since=                 — recent signal feed (read-only, for future dashboard)

POST   /v1/webhooks/stripe                — subscription lifecycle events
```

Internal endpoints (called only by execution agents / signal tracker, never end users) should sit behind `PLATFORM_API_KEY` auth distinct from user-facing JWT auth — don't reuse the same auth path for both trust boundaries.

---

## 16. Environments

- **Local/dev:** Hyperliquid testnet (`api.hyperliquid-testnet.xyz`) for API mechanics and integration tests. Accept that testnet won't validate real fill/slippage behavior — it validates that your code talks to the API correctly, nothing more.
- **Staging:** mainnet, real agent wallets, hard-capped position sizes (e.g. $10-25 max per trade) — this is your soak-test environment for Zeabur latency/reliability (§7) before any real user onboarding.
- **Production:** mainnet, per-user position caps as configured, full monitoring/alerting live from day one — not bolted on after launch.

---

## 17. Explicit V1 Exclusions (deferred to v2+)

- Performance-fee billing / AUM-linked pricing
- OKX or any second execution venue
- LLM-generated signals (news/chart analysis) — v1's LLM touchpoint is filtering only
- User-submitted custom tracked wallets or multiple signal-source types
- BYO-LLM-key support (v1 uses Zeabur AI Hub exclusively)
- Signal-provider marketplace, ranking/leaderboard, discovery
- Automatic position-flattening on circuit-breaker trip (v1 stops new trades, does not auto-close existing positions)
- Tiered/priority signal delivery
- Public third-party API access
- Frontend/dashboard (this doc is backend-only by request)

---

## 18. Build Order

**Three repos to build:**

| Repo | What it is |
|------|------------|
| `backend/` | Core API (auth, billing, DB, provisioning) |
| `signal-tracker/` | Single service polling Hyperliquid, emitting signals |
| `execution-agent/` | Per-user container consuming signals, placing orders |

**Build steps:**

| Step | Repo | What | Notes |
|------|------|------|-------|
| 1 | `backend/` | Postgres schema + auth skeleton (`users`, `execution_agents`, `audit_log`) | No Hyperliquid or Zeabur integration yet |
| 2 | `signal-tracker/` | Hardcoded wallet list, write to `signals` + Redis Stream | Validate in isolation before touching execution |
| 3 | `backend/` | Zeabur provisioner wrapper (`deployTemplate`, `suspendService`, log streaming) | Test against "hello world" worker image first |
| 4 | `execution-agent/` | Consume signals, apply static risk filter, place test orders on Hyperliquid testnet | No LLM, no jitter yet — deterministic path first |
| 5 | `execution-agent/` | Add jitter, heartbeats, circuit breaker, telemetry hot path | |
| 6 | All three | Staging soak test on mainnet with hard-capped position sizes ($10-25) | Test Zeabur reliability under real conditions |
| 7 | `execution-agent/` | Add LLM filter layer (§10) | Last, only after deterministic path proven |
| 8 | `backend/` | Stripe billing integration + subscription gating | |
| 9 | — | Small real-user pilot at capped position sizes | Before removing caps |