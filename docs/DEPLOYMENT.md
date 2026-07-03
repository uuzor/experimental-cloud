# Deployment Guide

This guide covers deploying the AI Copy-Trading Signal Platform to Zeabur.

## Prerequisites

- [Zeabur](https://zeabur.com) account
- GitHub repository with Docker images
- Domain name (optional, Zeabur provides subdomain)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         ZEABUR                              │
│  ┌─────────────┐  ┌─────────────────┐  ┌──────────────┐    │
│  │   Backend   │  │  Signal Tracker │  │    Redis     │    │
│  │   :3000     │──│     :3001       │──│              │    │
│  └─────────────┘  └─────────────────┘  └──────────────┘    │
│         │                                          │        │
│         │              ┌──────────────┐            │        │
│         └──────────────│  PostgreSQL  │◄───────────┘        │
│                        └──────────────┘                     │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              EXECUTION AGENTS (per-user)            │    │
│  │  Provisioned dynamically when users create agents  │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## Step 1: Enable GitHub Actions

The Docker images are built automatically when you push to `main`.

1. Go to your GitHub repository
2. Navigate to **Settings → Secrets and variables → Actions**
3. Add these secrets:
   - `ZEABUR_PROJECT_ID` - Your Zeabur project ID
   - `ZEABUR_API_KEY` - From Zeabur dashboard

## Step 2: Create Zeabur Project

1. Log in to [Zeabur](https://dash.zeabur.com)
2. Click **Create Project**
3. Name it `ai-copytrading`
4. Add services:
   - **PostgreSQL** - Database
   - **Redis** - Signal pub/sub

## Step 3: Deploy Backend

### Option A: Manual via Zeabur Dashboard

1. Click **Add Service** → **Prebuilt Service**
2. Search for your backend image: `ghcr.io/uuzor/experimental-cloud/backend:latest`
3. Configure environment variables:
   ```
   DATABASE_URL=${POSTGRES_CONNECTION_STRING}
   JWT_SECRET=<generate-strong-password>
   PLATFORM_API_KEY=<generate-api-key>
   REDIS_URL=${REDIS_URL}
   PORT=3000
   ```

### Option B: GitHub Actions (Recommended)

1. Go to **Actions** tab in your GitHub repo
2. Select **"Deploy to Zeabur"** workflow
3. Click **Run workflow**
4. Select:
   - Service: `backend`
   - Environment: `production`
5. Click **Run workflow**

## Step 4: Deploy Signal Tracker

1. Add another Prebuilt Service
2. Image: `ghcr.io/uuzor/experimental-cloud/signal-tracker:latest`
3. Environment variables:
   ```
   REDIS_URL=${REDIS_URL}
   BACKEND_URL=https://<your-backend-domain>
   HYPERLIQUID_NETWORK=testnet
   POLL_INTERVAL_MS=10000
   ```

## Step 5: Configure Domain

Zeabur provides a free subdomain. In your service settings:

1. Enable **Public Domain**
2. Note the URL for backend (e.g., `backend-xxx.zeabur.app`)
3. Update signal tracker `BACKEND_URL` with the backend URL

## Step 6: Update GitHub Actions Secrets

In GitHub repo Settings → Actions Secrets:

```
ZEABUR_PROJECT_ID=proj_xxxxxxxxxxxx
ZEABUR_API_KEY=zb_xxxxxxxxxxxx
```

## Deployment Verification

Check health endpoints:

```bash
# Backend
curl https://<backend-domain>/health

# Signal Tracker  
curl https://<tracker-domain>/health
```

## Database Migration

Run migrations manually or restart the backend service:

```bash
# The backend auto-runs migrations on startup
# Or run manually:
kubectl exec -it backend-xxx -- node dist/db/migrate.js
```

## Monitoring

### Backend Logs
View in Zeabur dashboard → Backend → Logs

### Signal Tracker Logs
View in Zeabur dashboard → Signal Tracker → Logs

### Check Redis Connection
```bash
redis-cli -u ${REDIS_URL} ping
```

## Troubleshooting

### Backend won't start
- Check DATABASE_URL is set correctly
- Verify PostgreSQL is running
- Check logs for migration errors

### Signal Tracker not emitting signals
- Verify REDIS_URL is correct
- Check HYPERLIQUID_NETWORK setting
- Verify BACKEND_URL is accessible

### Agents not starting
- Check PLATFORM_API_KEY matches backend
- Verify EXECUTION_AGENT_IMAGE exists in GHCR

## Environment Variables Reference

### Backend
| Variable | Required | Description |
|----------|----------|-------------|
| DATABASE_URL | Yes | PostgreSQL connection string |
| REDIS_URL | Yes | Redis connection string |
| JWT_SECRET | Yes | JWT signing secret |
| PLATFORM_API_KEY | Yes | Internal API key |
| BACKEND_URL | No | Public URL of backend |
| PORT | No | Default: 3000 |

### Signal Tracker
| Variable | Required | Description |
|----------|----------|-------------|
| REDIS_URL | Yes | Redis connection string |
| BACKEND_URL | Yes | Backend API URL |
| HYPERLIQUID_NETWORK | No | `testnet` or `mainnet` |
| POLL_INTERVAL_MS | No | Default: 10000 |
| TRACKED_TRADERS | No | Comma-separated addresses |

### Execution Agent
| Variable | Required | Description |
|----------|----------|-------------|
| AGENT_ID | Yes | Agent UUID (from backend) |
| AGENT_TOKEN | Yes | Auth token (from backend) |
| BACKEND_URL | Yes | Backend API URL |
| REDIS_URL | Yes | Redis connection string |
| PLATFORM_API_KEY | Yes | Internal API key |
| MAX_POSITION_USD | No | Default: 100 |
| MAX_LEVERAGE | No | Default: 3 |
