import { Pool } from 'pg';
import { logger } from './logger.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function migrate() {
  logger.info('Starting database migration...');

  try {
    // Create UUID extension
    await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

    // Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        subscription_status TEXT NOT NULL DEFAULT 'inactive',
        stripe_customer_id TEXT,
        timezone TEXT DEFAULT 'UTC',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    logger.info('Created users table');

    // Hyperliquid agent wallets table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hl_agent_wallets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        agent_address TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        encrypted_agent_key TEXT,
        master_address TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    logger.info('Created hl_agent_wallets table');

    // Execution agents table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS execution_agents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        wallet_id UUID REFERENCES hl_agent_wallets(id),
        agent_token TEXT,
        zeabur_service_id TEXT,
        internal_url TEXT,
        status TEXT NOT NULL DEFAULT 'provisioning',
        max_position_usd DECIMAL(12, 2) NOT NULL DEFAULT 100,
        max_leverage INTEGER NOT NULL DEFAULT 3,
        daily_loss_limit_usd DECIMAL(12, 2),
        llm_filter_enabled BOOLEAN NOT NULL DEFAULT false,
        last_heartbeat TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    logger.info('Created execution_agents table');

    // Audit log table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor UUID,
        actor_type TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id UUID,
        detail JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    logger.info('Created audit_log table');

    // Signals table (for signal tracker)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS signals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        trader_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        action TEXT NOT NULL,
        side TEXT NOT NULL,
        size DECIMAL(18, 8),
        entry_price DECIMAL(18, 8),
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    logger.info('Created signals table');

    // Indexes
    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_hl_agent_wallets_user_id ON hl_agent_wallets(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_hl_agent_wallets_address ON hl_agent_wallets(agent_address)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_execution_agents_user_id ON execution_agents(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_execution_agents_wallet_id ON execution_agents(wallet_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_execution_agents_status ON execution_agents(status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_signals_trader_address ON signals(trader_address)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC)');
    logger.info('Created indexes');

    logger.info('Database migration completed successfully');
  } catch (err) {
    logger.error({ err }, 'Migration failed');
    throw err;
  } finally {
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
