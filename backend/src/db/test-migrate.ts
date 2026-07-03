import { Pool } from 'pg';

// Test database pool - use env or default
const TEST_DATABASE_URL = process.env.DATABASE_URL || 
  'postgresql://root:DrexQgMHa17TW4folbv6LO8I0Z2kV395@5.161.69.12:31721/ai_copytrading_test';

const ADMIN_DATABASE_URL = process.env.ADMIN_DATABASE_URL || 
  'postgresql://root:DrexQgMHa17TW4folbv6LO8I0Z2kV395@5.161.69.12:31721/postgres';

export const testPool = new Pool({
  connectionString: TEST_DATABASE_URL,
  max: 5,
});

export async function setupTestDatabase(): Promise<void> {
  // Create test database if not exists
  const adminPool = new Pool({
    connectionString: ADMIN_DATABASE_URL,
  });

  try {
    // Check if test db exists
    const result = await adminPool.query(
      "SELECT 1 FROM pg_database WHERE datname = 'ai_copytrading_test'"
    );
    
    if (result.rows.length === 0) {
      await adminPool.query('CREATE DATABASE ai_copytrading_test');
      console.log('Created test database');
    }
  } catch (error) {
    console.log('Test database may already exist:', error);
  } finally {
    await adminPool.end();
  }

  // Run migrations on test db
  await testPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) UNIQUE NOT NULL,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await testPool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      trader_address VARCHAR(100) NOT NULL,
      status VARCHAR(50) DEFAULT 'active',
      max_position_size DECIMAL(10,2) DEFAULT 100,
      max_leverage INTEGER DEFAULT 10,
      stop_loss_percent DECIMAL(5,2) DEFAULT 5,
      take_profit_percent DECIMAL(5,2) DEFAULT 10,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await testPool.query(`
    CREATE TABLE IF NOT EXISTS traders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      address VARCHAR(100) UNIQUE NOT NULL,
      username VARCHAR(100),
      is_verified BOOLEAN DEFAULT false,
      total_subscribers INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await testPool.query(`
    CREATE TABLE IF NOT EXISTS execution_agents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      address VARCHAR(100) UNIQUE NOT NULL,
      label VARCHAR(100),
      status VARCHAR(50) DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await testPool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID NOT NULL REFERENCES execution_agents(id) ON DELETE CASCADE,
      subscription_id UUID REFERENCES subscriptions(id),
      trader_address VARCHAR(100) NOT NULL,
      symbol VARCHAR(50) NOT NULL,
      side VARCHAR(10) NOT NULL,
      size DECIMAL(20,8) NOT NULL,
      price DECIMAL(20,8) NOT NULL,
      pnl DECIMAL(20,8) DEFAULT 0,
      executed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await testPool.query(`
    CREATE TABLE IF NOT EXISTS signals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      trader_address VARCHAR(100) NOT NULL,
      symbol VARCHAR(50) NOT NULL,
      side VARCHAR(10) NOT NULL,
      price DECIMAL(20,8) NOT NULL,
      size DECIMAL(20,8) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log('Test database schema created');
}

export async function cleanupTestDatabase(): Promise<void> {
  await testPool.query('DELETE FROM trades');
  await testPool.query('DELETE FROM signals');
  await testPool.query('DELETE FROM subscriptions');
  await testPool.query('DELETE FROM execution_agents');
  await testPool.query('DELETE FROM users');
  await testPool.query('DELETE FROM traders');
}

export async function closeTestPool(): Promise<void> {
  await testPool.end();
}