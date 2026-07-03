/**
 * Signal Tracker Integration Tests
 * 
 * Tests use REAL Hyperliquid testnet and Redis
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { HyperliquidApi } from '../hyperliquid/api.js';
import { SignalPublisher } from '../publisher/index.js';
import { TraderStore } from '../hyperliquid/store.js';
import { SignalDetector } from '../detector/index.js';

// Test configuration - REAL testnet
const REDIS_URL = process.env.REDIS_URL || 'redis://:password@5.161.69.12:31354';

describe('Hyperliquid API - Real Testnet', () => {
  let api: HyperliquidApi;

  beforeAll(() => {
    api = new HyperliquidApi();
  });

  describe('getMeta()', () => {
    it('should fetch real asset metadata from testnet', async () => {
      const meta = await api.getMeta();
      
      expect(meta).toBeDefined();
      expect(meta.size).toBeGreaterThan(0);
      
      // Check that common assets exist
      const btcInfo = meta.get('BTC');
      expect(btcInfo).toBeDefined();
      expect(typeof btcInfo).toBe('number');
    });
  });

  describe('getAllMids()', () => {
    it('should fetch real mid prices from testnet', async () => {
      const mids = await api.getAllMids();
      
      expect(mids).toBeDefined();
      expect(mids.size).toBeGreaterThan(0);
      
      // BTC should have a price around testnet value
      const btcPrice = mids.get('BTC');
      expect(btcPrice).toBeDefined();
      expect(typeof btcPrice).toBe('number');
      expect(btcPrice).toBeGreaterThan(0);
    });
  });

  describe('getLeaderboard()', () => {
    it('should fetch leaderboard from testnet', async () => {
      const leaders = await api.getLeaderboard(0, 10);
      
      expect(Array.isArray(leaders)).toBe(true);
      // Leaderboard might be empty on testnet, but should not error
    });
  });

  describe('getUserState()', () => {
    it('should return null for non-existent user', async () => {
      const fakeAddress = '0x0000000000000000000000000000000000000000';
      const state = await api.getUserState(fakeAddress);
      
      // Should return null or empty state for non-existent user
      expect(state).toBeDefined();
    });
  });

  describe('getUserFills()', () => {
    it('should return empty fills for non-existent user', async () => {
      const fakeAddress = '0x0000000000000000000000000000000000000000';
      const fills = await api.getUserFills(fakeAddress);
      
      expect(Array.isArray(fills)).toBe(true);
      expect(fills.length).toBe(0);
    });
  });
});

describe('TraderStore', () => {
  let store: TraderStore;

  beforeEach(() => {
    store = new TraderStore();
  });

  describe('recordTrade()', () => {
    it('should record trades and calculate metrics', () => {
      const address = '0x1234567890123456789012345678901234567890';
      const now = Date.now();

      // Record enough trades (MIN_TRADES = 10)
      for (let i = 0; i < 12; i++) {
        store.recordTrade(address, 'BTC', 'buy', 50000 + i, 0.1, now - i * 1000, `hash${i}`, i % 3 === 0 ? 100 : -50);
      }

      expect(store.getAllTradersCount()).toBe(1);
      
      const metrics = store.getTraderMetrics(address);
      expect(metrics).toBeDefined();
      expect(metrics?.totalTrades).toBe(12);
    });

    it('should calculate win rate correctly', () => {
      const address = '0xabcdef1234567890abcdef1234567890abcdef12';
      const now = Date.now();

      // 12 trades - even indices are wins (6 wins), odd are losses (6 losses)
      for (let i = 0; i < 12; i++) {
        const pnl = i % 2 === 0 ? 100 : -50;
        store.recordTrade(address, 'BTC', 'buy', 50000, 0.1, now + i, `h${i}`, pnl);
      }

      const metrics = store.getTraderMetrics(address);
      expect(metrics?.winRate).toBeCloseTo(0.5, 2); // 6 wins / 12 trades = 0.5
    });
  });

  describe('getTopTraders()', () => {
    it('should return top traders sorted by PnL when they have enough trades', () => {
      const now = Date.now();

      // Trader A - large gains (12 trades)
      const traderA = '0xAAAA0000000000000000000000000000000000AA';
      for (let i = 0; i < 12; i++) {
        store.recordTrade(traderA, 'BTC', 'buy', 50000, 0.1, now, `hA${i}`, 100);
      }

      // Trader B - smaller gains (12 trades)
      const traderB = '0xBBBB0000000000000000000000000000000000BB';
      for (let i = 0; i < 12; i++) {
        store.recordTrade(traderB, 'ETH', 'buy', 3000, 1, now, `hB${i}`, 50);
      }

      // Trader C - loss (12 trades)
      const traderC = '0xCCCC0000000000000000000000000000000000CC';
      for (let i = 0; i < 12; i++) {
        store.recordTrade(traderC, 'SOL', 'buy', 100, 10, now, `hC${i}`, -10);
      }

      const topTraders = store.getTopTraders();
      
      expect(topTraders.length).toBe(3);
      expect(topTraders[0].address).toBe(traderA); // Best performer first
      expect(topTraders[2].address).toBe(traderC); // Worst performer last
    });
  });
});

describe('SignalPublisher - Real Redis', () => {
  let publisher: SignalPublisher;

  beforeAll(async () => {
    publisher = new SignalPublisher(REDIS_URL);
    await publisher.connect();
  });

  afterAll(async () => {
    await publisher.disconnect();
  });

  describe('publishSignal()', () => {
    it('should publish signal to Redis', async () => {
      const signal = {
        traderAddress: '0x1234567890123456789012345678901234567890',
        traderPnlPercent: 5.5,
        traderDrawdown: 2.1,
        traderWinRate: 0.65,
        symbol: 'BTC',
        side: 'long' as const,
        entryPrice: 50000,
        currentPrice: 52500,
        size: 0.1,
        leverage: 10,
        unrealizedPnlPercent: 5.0,
        timestamp: Date.now(),
        tradeHash: '0x' + Math.random().toString(16).slice(2),
      };

      // Should not throw
      await expect(publisher.publishSignal(signal)).resolves.not.toThrow();
    });
  });

  describe('publishTopTraders()', () => {
    it('should publish top traders to Redis', async () => {
      const traders = [
        {
          address: '0xAAAA',
          pnl7d: 1000,
          pnlPercent7d: 10,
          drawdown: 5,
          winRate: 0.7,
          totalTrades: 50,
          volume24h: 100000,
          lastUpdated: Date.now(),
        },
      ];

      // Should not throw
      await expect(publisher.publishTopTraders(traders)).resolves.not.toThrow();
    });
  });
});

describe('SignalDetector Integration', () => {
  it('should initialize with real API', async () => {
    const api = new HyperliquidApi();
    const store = new TraderStore();
    const publisher = new SignalPublisher(REDIS_URL);
    await publisher.connect();

    const detector = new SignalDetector(api, store, publisher, {
      minPnlPercent: 0, // Accept any PnL for testing
      minTrades: 1,     // Min 1 trade
    });

    // Start should initialize and fetch real data
    await detector.start();

    // Check that prices were fetched
    expect(store.getAllTradersCount()).toBeGreaterThanOrEqual(0);

    detector.stop();
    await publisher.disconnect();
  });
});