# API Reference

## Base URL

```
Production: https://your-backend-domain.com
Staging:   https://your-staging-domain.com
Local:     http://localhost:3000
```

## Authentication

### User Authentication (JWT)

All user-facing endpoints require a JWT token in the Authorization header:

```
Authorization: Bearer <token>
```

### Internal Authentication (PLATFORM_API_KEY)

Agent-to-backend communication uses a platform API key:

```
X-Platform-Key: <platform_api_key>
```

---

## Endpoints

### Authentication

#### POST /v1/auth/register

Register a new user account.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "SecurePassword123!",
  "username": "trader_joe"
}
```

**Response** (201 Created):
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "username": "trader_joe",
    "subscriptionStatus": "inactive"
  }
}
```

**Errors:**
- `400 Bad Request` - Validation failed
- `409 Conflict` - Email already registered

---

#### POST /v1/auth/login

Authenticate and receive a JWT token.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "SecurePassword123!"
}
```

**Response** (200 OK):
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "username": "trader_joe",
    "subscriptionStatus": "active"
  }
}
```

---

#### GET /v1/auth/me

Get current authenticated user.

**Headers:** `Authorization: Bearer <token>`

**Response** (200 OK):
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "username": "trader_joe",
  "subscriptionStatus": "active",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

---

### Execution Agents

#### POST /v1/execution-agents

Create and provision a new execution agent.

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "agentName": "My Trading Agent",
  "walletAddress": "0x1234...abcd"
}
```

**Response** (201 Created):
```json
{
  "id": "660e8400-e29b-41d4-a716-446655440001",
  "agentName": "My Trading Agent",
  "status": "provisioning",
  "config": {
    "maxLeverage": 3,
    "maxPositionSizeUsd": 100.0,
    "allowedSymbols": ["BTC", "ETH"]
  },
  "internalUrl": "https://agent-xxx.zeabur.app",
  "createdAt": "2024-01-15T10:35:00Z"
}
```

---

#### GET /v1/execution-agents/:id

Get execution agent status.

**Headers:** `Authorization: Bearer <token>`

**Response** (200 OK):
```json
{
  "id": "660e8400-e29b-41d4-a716-446655440001",
  "agentName": "My Trading Agent",
  "status": "active",
  "config": {
    "maxLeverage": 3,
    "maxPositionSizeUsd": 100.0
  },
  "lastHeartbeat": "2024-01-15T10:40:00Z",
  "tradesExecuted": 42,
  "createdAt": "2024-01-15T10:35:00Z"
}
```

---

#### PATCH /v1/execution-agents/:id/config

Update agent configuration (live-refreshed by agent).

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "maxLeverage": 5,
  "maxPositionSizeUsd": 200.0,
  "stopLossPct": 3.0,
  "allowedSymbols": ["BTC", "ETH", "SOL"]
}
```

**Response** (200 OK):
```json
{
  "id": "660e8400-e29b-41d4-a716-446655440001",
  "config": {
    "maxLeverage": 5,
    "maxPositionSizeUsd": 200.0,
    "stopLossPct": 3.0,
    "allowedSymbols": ["BTC", "ETH", "SOL"]
  },
  "updatedAt": "2024-01-15T10:45:00Z"
}
```

---

#### POST /v1/execution-agents/:id/suspend

Suspend an agent (stops trading, keeps state).

**Headers:** `Authorization: Bearer <token>`

**Response** (200 OK):
```json
{
  "id": "660e8400-e29b-41d4-a716-446655440001",
  "status": "suspended",
  "suspendedAt": "2024-01-15T10:50:00Z"
}
```

---

#### DELETE /v1/execution-agents/:id

Delete an agent (triggers Zeabur service deletion).

**Headers:** `Authorization: Bearer <token>`

**Response:** `204 No Content`

---

### Internal Endpoints (Agent-to-Backend)

These endpoints are called by execution agents, not users.

#### POST /v1/agents/handshake

Agent boot handshake - registers agent with backend.

**Headers:** `X-Platform-Key: <platform_api_key>`

**Request:**
```json
{
  "agentId": "660e8400-e29b-41d4-a716-446655440001",
  "agentToken": "agent-secret-token",
  "port": 3002,
  "capabilities": ["trade", "telemetry"]
}
```

**Response** (200 OK):
```json
{
  "status": "registered",
  "streamToken": "redis-stream-token-xxx",
  "config": {
    "maxLeverage": 3,
    "maxPositionSizeUsd": 100.0
  }
}
```

---

#### POST /v1/telemetry

Receive telemetry from execution agents.

**Headers:**
- `X-Platform-Key: <platform_api_key>`
- `X-Agent-Token: <agent_token>`

**Request:**
```json
{
  "agentId": "660e8400-e29b-41d4-a716-446655440001",
  "timestamp": "2024-01-15T10:55:00Z",
  "metrics": {
    "signalsReceived": 150,
    "signalsProcessed": 148,
    "tradesExecuted": 12,
    "avgExecutionTimeMs": 85
  },
  "positions": [
    {
      "symbol": "BTC",
      "side": "long",
      "size": 0.01,
      "entryPrice": 65000,
      "unrealizedPnl": 50.00
    }
  ]
}
```

**Response** (200 OK):
```json
{
  "received": true,
  "serverTime": "2024-01-15T10:55:01Z"
}
```

---

## Agent Control API (Backend -> Agent)

These endpoints are called BY the backend INTO running agents.

| Method | Path | Description |
|--------|------|-------------|
| GET | `{agent_url}/internal/health` | Health check |
| POST | `{agent_url}/internal/pause` | Pause trading |
| POST | `{agent_url}/internal/resume` | Resume trading |
| POST | `{agent_url}/internal/config` | Push new config |
| POST | `{agent_url}/internal/flatten` | Close all positions |
| GET | `{agent_url}/internal/state` | Get agent state |

---

## Error Format

All errors follow this format:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid email format",
    "details": {
      "field": "email",
      "value": "not-an-email"
    }
  }
}
```

**Error Codes:**

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Request validation failed |
| `UNAUTHORIZED` | 401 | Invalid or missing auth |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `CONFLICT` | 409 | Resource already exists |
| `PAYMENT_REQUIRED` | 402 | Subscription required |
| `INTERNAL_ERROR` | 500 | Server error |
