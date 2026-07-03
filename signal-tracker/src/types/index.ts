// Hyperliquid types
export interface HyperliquidUserTrade {
  0: string; // hash
  1: string; // sids (slot ids)
  2: number; // cross
  3: string; // px
  4: string; // sz
  5: number; // date
  6: string; // pm
  7: number; // tid
}

export interface HyperliquidPerpTrade {
  0: string; // hash
  1: string; // sids
  2: string; // px
  3: string; // sz
  4: number; // time
  5: string; // ledgerLine
}

export interface HyperliquidOrder {
  oid: string;
  symbol: string;
  side: 'B' | 'A'; // buy or ask/sell
  sz: string;
  px: string;
  timestamp: number;
  orderType: {
    type: 'Market' | 'Limit' | 'Stop' | 'Trigger' | 'MarketLimit' | 'LimitTpsl' | 'StopTpsl';
    limit?: { limitPrice: string; n: number; }; // TWAP parameters
    trigger?: { triggerPx: string; tpslMode?: string; };
  };
  filled: string;
  reduceOnly: boolean;
  hash: string;
  orderTypeClass: 'market' | 'limit' | 'stop' | 'trigger';
}

export interface HyperliquidTrade {
  hash: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  timestamp: number;
  userAddress: string;
}

// Signal types
export interface TradingSignal {
  traderAddress: string;
  traderPnlPercent: number; // Last 7-day PnL %
  traderDrawdown: number; // Current max drawdown %
  traderWinRate: number; // Win rate %
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  currentPrice: number;
  size: number;
  leverage: number;
  unrealizedPnlPercent: number;
  timestamp: number;
  tradeHash: string;
}

export interface TopTrader {
  address: string;
  pnl7d: number;
  pnlPercent7d: number;
  drawdown: number;
  winRate: number;
  totalTrades: number;
  volume24h: number;
  lastUpdated: number;
}

// Redis pub/sub channels
export const SIGNAL_CHANNEL = 'trading_signals';
export const TOP_TRADERS_CHANNEL = 'top_traders';