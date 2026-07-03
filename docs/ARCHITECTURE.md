# System Architecture Documentation

## Overview

The AI Copy-Trading Signal Platform (V1) enables automated copy-trading on Hyperliquid by tracking top traders and replicating their trades for subscribed users.

## High-Level Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SYSTEM ARCHITECTURE                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐                                                    │
│  │ Hyperliquid  │◄─────────────────────────────────────────────────┐   │
│  │ Testnet/     │                                                  │   │
│  │ Mainnet API  │                                                  │   │
│  └──────┬───────┘                                                  │   │
│         │ 1. Poll positions                                         │   │
│         ▼                                                           │   │
│  ┌──────────────┐     2. Detect changes                             │   │
│  │ Signal       │────────────┐                                      │   │
│  │ Tracker      │            │                                      │   │
│  │ (TypeScript) │            ▼                                      │   │
│  │              │     ┌──────────────┐                              │   │
│  │              │     │ Redis        │                              │   │
│  │              │────►│ signals:v1   │                              │   │
│  └──────────────┘     └──────┬───────┘                              │   │
│                              │ 3. Fan-out                           │   │
│                              ▼                                      │   │
│  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │                  EXECUTION AGENTS (Per-User)               │   │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                   │   │   │
│  │  │ User A   │  │ User B   │  │ User N   │                   │   │   │
│  │  │ Container│  │ Container│  │ Container│                   │   │   │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘                   │   │   │
│  └───────┼─────────────┼─────────────┼──────────────────────────┘   │   │
│          │ 4. Execute │             │                              │   │
│          ▼            ▼             ▼                              │   │
│  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │              Hyperliquid Exchange                            │   │   │
│  │              (Agent wallets trade)                          │   │   │
│  └─────────────────────────────────────────────────────────────┘   │   │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │                      CORE BACKEND API                        │   │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐       │   │   │
│  │  │ Auth    │  │ Billing │  │ Telemetry│ │ Provision│       │   │   │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘       │   │   │
│  │                      │                                      │   │   │
│  │                      ▼                                      │   │   │
│  │               ┌─────────────┐                                │   │   │
│  │               │ PostgreSQL  │                                │   │   │
│  │               └─────────────┘                                │   │   │
│  └─────────────────────────────────────────────────────────────┘   │   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Signal Tracker (`signal-tracker/`)

**Purpose:** Monitors Hyperliquid wallets, emits position change signals.

**Tech:** TypeScript, Node.js, ioredis

**Flow:**
1. Poll HL Info API periodically
2. Compare with previous state
3. Publish changes to Redis `signals:v1`

### 2. Execution Agent (`execution-agent/`)

**Purpose:** Per-user container that executes trades with risk controls.

**Tech:** Python 3.11, web3, eth-account, redis

**Flow:**
1. Subscribe to Redis `signals:v1`
2. Validate against risk limits
3. Apply jitter (0-250ms)
4. Sign and broadcast to Hyperliquid

### 3. Backend API (`backend/`)

**Purpose:** Auth, billing, agent provisioning, telemetry.

**Tech:** TypeScript, Fastify, PostgreSQL, JWT

**Endpoints:**
- `/v1/auth/*` - User authentication
- `/v1/execution-agents/*` - Agent management
- `/v1/agents/*` - Internal agent endpoints
- `/v1/telemetry` - Telemetry ingestion

## Signal Flow (Step-by-Step)

### 1. Signal Generation
```
Signal Tracker → HL API → Compare State → Detect Change → Redis Pub
```

### 2. Signal Consumption
```
Execution Agent → Redis Sub → Validate Risk → Apply Jitter → Execute
```

### 3. Order Execution
```
Execution Agent → Sign Order → HL Exchange → Receive Fill → Telemetry
```

## Security Model

### Wallet Isolation
```
User's Master Wallet
      │
      │ (never touches our infrastructure)
      ▼
┌─────────────────┐
│ approveAgent    │ Creates agent wallet with permissions
└────────┬────────┘
         │
         ▼
┌─────────────────┐     Stored encrypted
│ Agent Wallet    │◄──────────────────────► Our DB
└────────┬────────┘
         │
         │ Signs orders only
         ▼
┌─────────────────┐
│ Hyperliquid     │
│ (can trade,     │
│  cannot withdraw)│
└─────────────────┘
```

## Trust Boundaries

| Boundary | Auth Method | Purpose |
|----------|-------------|---------|
| User → Backend | JWT | User operations |
| Agent → Backend | PLATFORM_API_KEY | Telemetry, handshake |
| Backend → Agent | Agent token | Control (pause/resume) |
| Signal Tracker → Redis | None (internal) | Signal publishing |

## Deployment Topology

```
┌─────────────────┐
│ Zeabur Project  │
├─────────────────┤
│  ┌───────────┐   │
│  │ Backend   │   │ Single instance
│  │ :3000     │   │
│  └───────────┘   │
│        │         │
│  ┌───────────┐   │
│  │ Signal    │   │ Single instance
│  │ Tracker   │   │
│  │ :3001     │   │
│  └───────────┘   │
│        │         │
│  ┌───────────┐   │
│  │ Redis     │   │ Zeabur add-on
│  └───────────┘   │
│        │         │
│  ┌───────────┐   │
│  │ Postgres  │   │ Zeabur add-on
│  └───────────┘   │
└─────────────────┘
         │
    ┌────┴────┐
    │         │
┌───┴───┐ ┌───┴───┐
│User A │ │User B │ Per-user containers
│Agent  │ │Agent  │
└───────┘ └───────┘
```

## Test Coverage

| Component | Tests | Type |
|-----------|-------|------|
| Backend | 8 | Validation |
| Signal Tracker | 11 | Integration |
| Execution Agent | 17 | Unit + Integration |
| **Total** | **36** | **All Passing** |

## Next Steps

1. Enable GitHub Actions for Docker builds
2. Deploy to Zeabur using infrastructure templates
3. Integrate Stripe for billing
4. Add monitoring/alerting
5. Implement LLM signal filtering
