import { createLogger } from '../utils/logger.js';
import type { TopTrader } from '../types/index.js';

const logger = createLogger('trader-store');

interface TraderMetrics {
  address: string;
  trades: Array<{
    symbol: string;
    side: 'buy' | 'sell';
    price: number;
    size: number;
    timestamp: number;
    hash: string;
    pnl: number;
  }>;
  wins: number;
  losses: number;
  totalPnl: number;
  peakEquity: number;
  currentEquity: number;
  lastUpdated: number;
}

export class TraderStore {
  private traders: Map<string, TraderMetrics> = new Map();
  private topTraders: TopTrader[] = [];
  private readonly MIN_TRADES = 10;
  private readonly WIN_RATE_WINDOW = 100; // Number of trades to calculate win rate

  recordTrade(
    address: string,
    symbol: string,
    side: 'buy' | 'sell',
    price: number,
    size: number,
    timestamp: number,
    hash: string,
    pnl: number = 0
  ): void {
    let trader = this.traders.get(address);
    
    if (!trader) {
      trader = {
        address,
        trades: [],
        wins: 0,
        losses: 0,
        totalPnl: 0,
        peakEquity: 10000, // Assume starting with 10k
        currentEquity: 10000,
        lastUpdated: timestamp,
      };
      this.traders.set(address, trader);
    }

    trader.trades.push({ symbol, side, price, size, timestamp, hash, pnl });
    
    if (pnl > 0) {
      trader.wins++;
    } else if (pnl < 0) {
      trader.losses++;
    }
    
    trader.totalPnl += pnl;
    trader.currentEquity += pnl;
    trader.peakEquity = Math.max(trader.peakEquity, trader.currentEquity);
    trader.lastUpdated = timestamp;

    // Recalculate top traders
    this.updateTopTraders();
  }

  private updateTopTraders(): void {
    const traders: TopTrader[] = [];

    for (const [address, trader] of this.traders) {
      if (trader.trades.length < this.MIN_TRADES) continue;

      const recentTrades = trader.trades.slice(-this.WIN_RATE_WINDOW);
      const wins = recentTrades.filter(t => t.pnl > 0).length;
      const winRate = wins / recentTrades.length;

      // Calculate 7-day PnL
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const recentPnls = trader.trades
        .filter(t => t.timestamp >= sevenDaysAgo)
        .map(t => t.pnl);
      const pnl7d = recentPnls.reduce((sum, pnl) => sum + pnl, 0);
      const pnlPercent7d = (pnl7d / trader.peakEquity) * 100;

      // Calculate drawdown
      const drawdown = ((trader.peakEquity - trader.currentEquity) / trader.peakEquity) * 100;

      // Calculate 24h volume
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const volume24h = trader.trades
        .filter(t => t.timestamp >= oneDayAgo)
        .reduce((sum, t) => sum + t.price * t.size, 0);

      traders.push({
        address,
        pnlPercent7d,
        drawdown,
        winRate,
        totalTrades: trader.trades.length,
        lastUpdated: trader.lastUpdated,
      });
    }

    // Sort by 7-day PnL percentage and take top 20
    traders.sort((a, b) => b.pnlPercent7d - a.pnlPercent7d);
    this.topTraders = traders.slice(0, 20);

    logger.debug({ count: this.topTraders.length }, 'Top traders updated');
  }

  getTopTraders(): TopTrader[] {
    return this.topTraders;
  }

  getTopTraderAddresses(): string[] {
    return this.topTraders.map(t => t.address);
  }

  getTraderMetrics(address: string): TopTrader | null {
    return this.topTraders.find(t => t.address === address) || null;
  }

  getAllTradersCount(): number {
    return this.traders.size;
  }
}