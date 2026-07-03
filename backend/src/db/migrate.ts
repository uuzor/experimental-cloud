import 'dotenv/config';
import pg from 'pg';
import { logger } from './logger.js';

const { Client } = pg;

const migrateLogger = logger.child({ module: 'migrate' });

const schema = `
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users
CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT UNIQUE NOT NULL,
  password_hash     TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  subscription_status TEXT NOT NULL DEFAULT 'inactive',
  stripe_customer_id TEXT,
  timezone          TEXT DEFAULT 'UTC'
);

-- Hyperliquid credentials — only ever the AGENT (API) wallet, never a master key
CREATE TABLE IF NOT EXISTS hl_agent_wallets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_address     TEXT NOT NULL,
  agent_name        TEXT NOT NULL,
  encrypted_agent_key TEXT NOT NULL,
  master_address    TEXT NOT NULL,
  registered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  status            TEXT NOT NULL DEFAULT 'active',
  UNIQUE (user_id)
);

-- Tracked top-trader wallets (curated signal source list — admin managed in v1)
CREATE TABLE IF NOT EXISTS tracked_wallets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address           TEXT UNIQUE NOT NULL,
  label             TEXT,
  added_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  active            BOOLEAN NOT NULL DEFAULT true
);

-- Raw signal events emitted by the tracker service
CREATE TABLE IF NOT EXISTS signals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_wallet_id UUID NOT NULL REFERENCES tracked_wallets(id),
  asset             TEXT NOT NULL,
  side              TEXT NOT NULL,
  size_delta        NUMERIC NOT NULL,
  leverage          NUMERIC,
  entry_price       NUMERIC,
  detected_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload       JSONB NOT NULL
);

-- User execution agent config (maps 1:1 to a Zeabur service)
CREATE TABLE IF NOT EXISTS execution_agents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  zeabur_service_id TEXT,
  zeabur_project_id TEXT,
  agent_internal_url TEXT,
  agent_control_token_hash TEXT,
  status            TEXT NOT NULL DEFAULT 'provisioning',
  max_position_usd  NUMERIC NOT NULL,
  max_leverage      NUMERIC NOT NULL DEFAULT 3,
  daily_loss_limit_usd NUMERIC,
  llm_filter_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat_at TIMESTAMPTZ
);

-- Executions resulting from signals (append-only audit trail)
CREATE TABLE IF NOT EXISTS executions (
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
  status            TEXT NOT NULL DEFAULT 'pending',
  error_detail      TEXT,
  jitter_ms_applied  INTEGER
);

-- Heartbeats (rolling — can be pruned/partitioned aggressively)
CREATE TABLE IF NOT EXISTS agent_heartbeats (
  id                BIGSERIAL PRIMARY KEY,
  execution_agent_id UUID NOT NULL REFERENCES execution_agents(id),
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  status            TEXT NOT NULL
);

-- Billing (flat subscription — Stripe is source of truth, this is a local mirror)
CREATE TABLE IF NOT EXISTS subscriptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT UNIQUE,
  plan              TEXT NOT NULL DEFAULT 'v1_flat',
  status            TEXT NOT NULL,
  current_period_end TIMESTAMPTZ
);

-- Audit log — every privileged action (provision, suspend, credential rotation)
CREATE TABLE IF NOT EXISTS audit_log (
  id                BIGSERIAL PRIMARY KEY,
  actor             TEXT NOT NULL,
  action            TEXT NOT NULL,
  target_type       TEXT NOT NULL,
  target_id         TEXT,
  detail            JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_signals_tracked_wallet ON signals(tracked_wallet_id);
CREATE INDEX IF NOT EXISTS idx_signals_detected_at ON signals(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_agent ON executions(execution_agent_id);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);
CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_agent ON agent_heartbeats(execution_agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);

-- Partition agent_heartbeats by month (optional - for high volume)
-- Note: Partitioning requires different syntax in Postgres 14+
-- For now, create a cleanup job to prune old heartbeats instead
`;

async function migrate() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    migrateLogger.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  migrateLogger.info('Starting database migration...');

  const client = new Client({
    connectionString: databaseUrl,
  });

  try {
    await client.connect();
    migrateLogger.info('Connected to database');

    await client.query(schema);
    migrateLogger.info('Schema created successfully');

    migrateLogger.info('Migration complete!');
  } catch (err) {
    migrateLogger.error({ err }, 'Migration failed');
    process.exit(1);
  } finally {
    await client.end();
  }
}

// Run if executed directly
migrate();
