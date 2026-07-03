# AI Copy-Trading Signal Platform (V1)

A production-ready backend for automated copy-trading on Hyperliquid using on-chain top-trader tracking.

## Architecture

```
┌─────────────────────────────┐
│   Signal Tracker Service    │
│  (polls Hyperliquid Info)  │
└──────────────┬─────────────┘
               │ publishes signals
               ▼
┌─────────────────────────────┐
│   Redis Streams (Pub/Sub)  │
│   channel: signals:v1      │
└──────────────┬─────────────┘
               │ fan-out
               ▼
┌─────────────────────────────┐
│   Execution Agents (per-user)
│   (consume signals, trade) │
└──────────────┬─────────────┘
               │ telemetry
               ▼
┌─────────────────────────────┐
│      Core Backend API       │
│  (auth, billing, control)  │
└─────────────────────────────┘
```

## Components

| Component | Tech Stack | Description |
|-----------|------------|-------------|
| `backend/` | TypeScript/Fastify | REST API, auth, billing, agent control |
| `signal-tracker/` | TypeScript/Node.js | Polls Hyperliquid, emits trading signals |
| `execution-agent/` | Python | Per-user container, risk management, order execution |

## Quick Start

### Prerequisites

- Node.js 20+
- Python 3.11+
- PostgreSQL 15+
- Redis 7+
- Docker (for deployment)

### Local Development

```bash
# Backend
cd backend
npm install
npm run dev

# Signal Tracker
cd signal-tracker
npm install
npm run dev

# Execution Agent
cd execution-agent
uv sync
python -m src.executor_agent.main
```

### Environment Variables

```bash
# backend/.env
DATABASE_URL=postgresql://user:pass@localhost:5432/ai_copytrading
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-secret-key
PLATFORM_API_KEY=your-platform-key

# signal-tracker/.env
REDIS_URL=redis://localhost:6379
BACKEND_URL=http://localhost:3000

# execution-agent/.env
REDIS_URL=redis://localhost:6379
HYPERLIQUID_NETWORK=testnet  # or mainnet
BACKEND_URL=http://localhost:3000
PLATFORM_API_KEY=your-platform-key
```

## Testing

```bash
# Run all tests
npm test                           # backend & signal-tracker
python -m pytest tests/            # execution-agent

# Test results:
# - Backend: 8 tests ✓
# - Signal Tracker: 11 tests ✓
# - Execution Agent: 17 tests ✓
```

## Deployment

### Docker Images

Images are built automatically via GitHub Actions and pushed to GHCR:

- `ghcr.io/uuzor/experimental-cloud/backend:latest`
- `ghcr.io/uuzor/experimental-cloud/signal-tracker:latest`
- `ghcr.io/uuzor/experimental-cloud/execution-agent:latest`

### Zeabur Deployment

Use the infrastructure templates in `infrastructure/`:

1. Create a Zeabur project
2. Add PostgreSQL and Redis dependencies
3. Deploy using templates or manual configuration

See `infrastructure/template.yaml` for the full configuration reference.

## API Endpoints

### Authentication
```
POST /v1/auth/register    - User registration
POST /v1/auth/login       - User login
GET  /v1/auth/me         - Get current user
```

### Execution Agents
```
POST   /v1/execution-agents              - Create agent
GET    /v1/execution-agents/:id          - Get agent status
PATCH  /v1/execution-agents/:id/config  - Update config
POST   /v1/execution-agents/:id/suspend - Suspend agent
DELETE /v1/execution-agents/:id          - Delete agent
```

### Internal (Agent-to-Backend)
```
POST /v1/agents/handshake    - Agent boot handshake
POST /v1/telemetry           - Submit telemetry
GET  /v1/agents/:id/stream-token - Get Redis stream token
```

## Security

- **Agent wallets only**: Only Hyperliquid agent (API) wallet keys are stored, never master keys
- **Envelope encryption**: Credentials encrypted at rest
- **Audit logging**: All privileged actions logged
- **Non-custodial**: User funds remain in their own wallets

## License

MIT
