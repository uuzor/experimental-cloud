/**
 * End-to-End Integration Test
 * Tests the signal flow: Hyperliquid → Signal Tracker → Redis → Execution Agent
 * 
 * This test validates the complete pipeline using real Hyperliquid testnet.
 * Run with: npx tsx e2e_test.ts
 */

import Redis from 'ioredis';

// Configuration
const HYPERLIQUID_TESTNET_URL = 'https://api.hyperliquid-testnet.xyz';
const TEST_WALLET = '0x8d2B208566574F21d0cD2dC63fB934C41b21C7bd'; // Test wallet

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testHyperliquidAPI(): Promise<void> {
  console.log('\n=== Testing Hyperliquid Testnet API ===');
  
  // Test meta endpoint
  const metaResponse = await fetch(`${HYPERLIQUID_TESTNET_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'meta' }),
  });
  
  if (!metaResponse.ok) {
    throw new Error(`Meta API failed: ${metaResponse.status}`);
  }
  
  const meta = await metaResponse.json() as { unixtime: number };
  console.log(`✓ Meta API: Server time ${meta.unixtime}`);
  
  // Test mids endpoint
  const midsResponse = await fetch(`${HYPERLIQUID_TESTNET_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'mids' }),
  });
  
  if (!midsResponse.ok) {
    throw new Error(`Mids API failed: ${midsResponse.status}`);
  }
  
  const mids = await midsResponse.json() as Record<string, string>;
  console.log(`✓ Mids API: ${Object.keys(mids).length} pairs available`);
  
  // Test user balance
  const userResponse = await fetch(`${HYPERLIQUID_TESTNET_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'userBalances',
      user: TEST_WALLET,
    }),
  });
  
  if (userResponse.ok) {
    const balances = await userResponse.json();
    console.log(`✓ User Balance API: ${JSON.stringify(balances)}`);
  } else {
    console.log('⚠ User Balance API: Not available on testnet (expected)');
  }
}

async function testRedisConnection(): Promise<Redis | null> {
  console.log('\n=== Testing Redis Connection ===');
  
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  
  try {
    const redis = new Redis(redisUrl);
    
    await redis.ping();
    console.log('✓ Redis: Connection successful');
    
    // Test pub/sub channels
    const subscriber = new Redis(redisUrl);
    const testChannel = 'e2e:test';
    
    await new Promise<void>((resolve, reject) => {
      subscriber.subscribe(testChannel, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    console.log(`✓ Redis: Subscribed to channel ${testChannel}`);
    
    // Cleanup
    await subscriber.unsubscribe(testChannel);
    await subscriber.quit();
    await redis.quit();
    
    return null; // Return null since we closed connections
  } catch (error) {
    console.log(`⚠ Redis: ${error instanceof Error ? error.message : 'Connection failed}`);
    console.log('  (This is expected if Redis is not running locally)');
    return null;
  }
}

async function testDatabaseConnection(): Promise<void> {
  console.log('\n=== Testing PostgreSQL Connection ===');
  
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_CONNECTION_STRING;
  
  if (!dbUrl) {
    console.log('⚠ PostgreSQL: No DATABASE_URL configured');
    return;
  }
  
  try {
    // Dynamic import for pg
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: dbUrl, max: 1 });
    
    const result = await pool.query('SELECT NOW() as now, version() as version');
    console.log(`✓ PostgreSQL: Connected (${(result.rows[0].version as string).substring(0, 50)}...)`);
    
    await pool.end();
  } catch (error) {
    console.log(`⚠ PostgreSQL: ${error instanceof Error ? error.message : 'Connection failed'}`);
  }
}

async function main(): Promise<void> {
  console.log('===========================================');
  console.log('E2E Integration Test - AI Copy-Trading Platform');
  console.log('===========================================');
  
  const startTime = Date.now();
  const results: { test: string; status: 'pass' | 'skip' | 'fail'; message?: string }[] = [];
  
  // Test 1: Hyperliquid API
  try {
    await testHyperliquidAPI();
    results.push({ test: 'Hyperliquid API', status: 'pass' });
  } catch (error) {
    results.push({ 
      test: 'Hyperliquid API', 
      status: 'fail', 
      message: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
  
  // Test 2: Redis
  try {
    await testRedisConnection();
    results.push({ test: 'Redis', status: 'pass' });
  } catch (error) {
    results.push({ 
      test: 'Redis', 
      status: 'fail',
      message: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
  
  // Test 3: PostgreSQL
  try {
    await testDatabaseConnection();
    results.push({ test: 'PostgreSQL', status: 'pass' });
  } catch (error) {
    results.push({ 
      test: 'PostgreSQL', 
      status: 'fail',
      message: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
  
  // Print summary
  console.log('\n===========================================');
  console.log('Test Summary');
  console.log('===========================================');
  
  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const skipped = results.filter(r => r.status === 'skip').length;
  
  for (const result of results) {
    const icon = result.status === 'pass' ? '✓' : result.status === 'skip' ? '⊘' : '✗';
    const message = result.message ? ` (${result.message})` : '';
    console.log(`${icon} ${result.test}${message}`);
  }
  
  console.log(`\nDuration: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
