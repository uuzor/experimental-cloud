import { createLogger } from '../utils/logger.js';
import { HyperliquidApi } from '../hyperliquid/api.js';
import { TraderStore } from '../hyperliquid/store.js';
import { SignalPublisher } from '../publisher/index.js';
import { TradingSignal, TopTrader } from '../types/index.js';

const logger = createLogger('signal-detector');

interface SignalConfig {
  minPnlPercent: number; // Minimum 7-day PnL % to be considered
  maxDrawdown: number; // Maximum allowed drawdown %
  minWinRate: number; // Minimum win rate %
  minTrades: number; // Minimum trades to qualify
  signalThreshold: number; // PnL % change to trigger a signal
}

const DEFAULT_CONFIG: SignalConfig = {
  minPnlPercent: 5, // Top traders must have >5% 7-day PnL
  maxDrawdown: 30, // Max 30% drawdown
  minWinRate: 0.4, // At least 40% win rate
  minTrades: 20, // At least 20 trades
  signalThreshold: 2, // Signal if position moved 2%+
};

export class SignalDetector {
  private api: HyperliquidApi;
  private store: TraderStore;
  private publisher: SignalPublisher;
  private config: SignalConfig;
  private lastPrices: Map<string, number> = new Map();
  private trackedAddresses: Set<string> = new Set();
  private pollInterval: NodeJS.Timeout | null = null;
  private readonly POLL_INTERVAL_MS = 60000; // Poll every minute

  constructor(
    api: HyperliquidApi,
    store: TraderStore,
    publisher: SignalPublisher,
    config: Partial<SignalConfig> = {}
  ) {
    this.api = api;
    this.store = store;
    this.publisher = publisher;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async start(): Promise<void> {
    logger.info('Starting signal detector...');

    // Initialize meta and mids
    await this.api.getMeta();
    const mids = await this.api.getAllMids();
    for (const [symbol, price] of mids) {
      this.lastPrices.set(symbol, price);
    }

    // Get initial top traders from leaderboard
    await this.refreshTopTraders();

    // Start polling
    this.pollInterval = setInterval(() => this.poll(), this.POLL_INTERVAL_MS);
    this.poll().catch((error) => logger.error({ error }, 'Initial poll failed'));
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async poll(): Promise<void> {
    logger.debug('Polling for updates...');

    try {
      // Update prices
      const mids = await this.api.getAllMids();
      for (const [symbol, price] of mids) {
        this.lastPrices.set(symbol, price);
      }

      // Refresh top traders periodically
      await this.refreshTopTraders();

      // Check tracked traders for new signals
      for (const address of this.trackedAddresses) {
        await this.checkTraderSignals(address);
      }
    } catch (error) {
      logger.error({ error }, 'Poll failed');
    }
  }

  private async refreshTopTraders(): Promise<void> {
    try {
      // Get traders from leaderboard
      const leaders = await this.api.getLeaderboard(0, 100);
      
      for (const leader of leaders) {
        // Fetch their trades to calculate metrics
        const fills = await this.api.getUserFills(leader.user);
        
        for (const fill of fills) {
          const side = parseInt(fill[4]) > 0 ? 'buy' : 'sell';
          this.store.recordTrade(
            leader.user,
            '', // symbol not in fills response
            side,
            parseFloat(fill[3]),
            parseFloat(fill[4]),
            fill[5] * 1000, // Convert to ms
            fill[0],
            0 // PnL not available from fills
          );
        }

        this.trackedAddresses.add(leader.user);
      }

      const topTraders = this.store.getTopTraders();
      
      // Filter by config
      const qualifiedTraders = topTraders.filter(t => 
        t.pnlPercent7d >= this.config.minPnlPercent &&
        t.drawdown <= this.config.maxDrawdown &&
        t.winRate >= this.config.minWinRate &&
        t.totalTrades >= this.config.minTrades
      );

      // Publish top traders
      await this.publisher.publishTopTraders(qualifiedTraders);
      
      logger.info({ 
        total: topTraders.length, 
        qualified: qualifiedTraders.length 
      }, 'Top traders refreshed');
    } catch (error) {
      logger.error({ error }, 'Failed to refresh top traders');
    }
  }

  private async checkTraderSignals(address: string): Promise<void> {
    try {
      // Get current positions
      const state = await this.api.getUserState(address);
      
      if (!state || !state.assetPositions || state.assetPositions.length === 0) {
        return;
      }

      // Get recent fills
      const recentTrades = await this.api.getUserFills(
        address,
        Date.now() - 60 * 60 * 1000 // Last hour
      );

      const traderMetrics = this.store.getTraderMetrics(address);
      if (!traderMetrics) return;

      for (const position of state.assetPositions) {
        const pos = position.position;
        const symbol = pos.coin;
        const currentPrice = parseFloat(pos.unrealizedPnlPercent.toString());
        const entryPrice = parseFloat(pos.positionValue.toString()) / parseFloat(pos.size);

        // Check if there's a new trade
        for (const fill of recentTrades) {
          const signal = this.generateSignal(
            address,
            traderMetrics,
            symbol,
            entryPrice,
            currentPrice,
            parseFloat(pos.size),
            parseFloat(pos.leverage.value.toString()),
            fill[0]
          );

          if (signal) {
            await this.publisher.publishSignal(signal);
            logger.info({ signal }, 'Signal generated');
          }
        }
      }
    } catch (error) {
      logger.error({ error, address }, 'Failed to check trader signals');
    }
  }

  private generateSignal(
    address: string,
    trader: TopTrader,
    symbol: string,
    entryPrice: number,
    currentPrice: number,
    size: number,
    leverage: number,
    tradeHash: string
  ): TradingSignal | null {
    const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    
    // Check if price moved enough to warrant a signal
    if (Math.abs(pnlPercent) < this.config.signalThreshold) {
      return null;
    }

    return {
      traderAddress: address,
      traderPnlPercent: trader.pnlPercent7d,
      traderDrawdown: trader.drawdown,
      traderWinRate: trader.winRate,
      symbol,
      side: pnlPercent > 0 ? 'long' : 'short',
      entryPrice,
      currentPrice,
      size,
      leverage,
      unrealizedPnlPercent: pnlPercent,
      timestamp: Date.now(),
      tradeHash,
    };
  }
}