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
    limit?: { limitPrice: string; n: number; };
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
  signalId: string;
  traderAddress: string;
  traderPnlPercent: number;
  traderDrawdown: number;
  traderWinRate: number;
  symbol: string;
  side: 'long' | 'short';
  action: 'open' | 'close' | 'adjust';
  entryPrice: number;
  currentPrice: number;
  size: number;
  leverage: number;
  unrealizedPnlPercent: number;
  timestamp: number;
  tradeHash: string;
}

// Redis pub/sub channels - V1
export const SIGNAL_CHANNEL = 'signals:v1';
export const TOP_TRADERS_CHANNEL = 'top_traders:v1';

// Top trader tracking
export interface TopTrader {
  address: string;
  pnlPercent7d: number;
  drawdown: number;
  winRate: number;
  totalTrades: number;
  lastUpdated: number;
}
