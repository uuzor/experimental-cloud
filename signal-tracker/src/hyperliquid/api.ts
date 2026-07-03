import { createLogger } from '../utils/logger.js';

const logger = createLogger('hyperliquid-api');

const BASE_URL = 'https://api.hyperliquid.xyz';

interface MetaResponse {
  universe: Array<{
    szDecimals: number;
    index: number;
    name: string;
    szIncrement: string;
  }>;
}

interface UserFill {
  0: string; // hash
  1: string; // sids
  2: number; // cross
  3: string; // px
  4: string; // sz
  5: number; // date
  6: string; // pm
  7: number; // tid
}

interface Order {
  oid: string;
  symbol: string;
  side: 'B' | 'A';
  sz: string;
  px: string;
  timestamp: number;
  orderType: { type: string; limit?: { limitPrice: string; n: number; }; trigger?: { triggerPx: string; tpslMode?: string; }; };
  filled: string;
  reduceOnly: boolean;
  hash: string;
  orderTypeClass: string;
}

interface UserFillsRequest {
  type: 'fills';
  user: string;
  startTime?: number;
}

interface UserFillsResponse {
  fills: UserFill[];
}

interface UserStateRequest {
  type: 'userState';
  user: string;
}

interface UserStateAssetPosition {
  coin: string;
  leverage: { value: number; type: string; };
  positionValue: number;
  size: string;
  marginUsed: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
}

interface UserStateResponse {
  assetPositions: Array<{ position: UserStateAssetPosition; }>;
  marginSummary: {
    totalMarginUsed: number;
    marginUsed: number;
    totalRawUsd: number;
    totalUnrealizedPnl: number;
  };
}

interface AllMidsRequest {
  type: 'allMids';
}

interface AllMidsResponse {
  [symbol: string]: string;
}

interface OrderRequest {
  type: 'orderFills';
  user: string;
  oid: string;
}

interface OrderFillsResponse {
  fills: UserFill[];
}

export class HyperliquidApi {
  private metaCache: Map<string, number> = new Map(); // symbol -> decimals
  private lastMetaFetch = 0;
  private readonly META_CACHE_TTL = 3600000; // 1 hour

  async getMeta(): Promise<Map<string, number>> {
    const now = Date.now();
    if (now - this.lastMetaFetch < this.META_CACHE_TTL && this.metaCache.size > 0) {
      return this.metaCache;
    }

    try {
      const response = await fetch(`${BASE_URL}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'meta' }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as MetaResponse;
      
      this.metaCache.clear();
      for (const asset of data.universe) {
        this.metaCache.set(asset.name, asset.szDecimals);
      }
      
      this.lastMetaFetch = now;
      logger.info({ count: this.metaCache.size }, 'Meta cache updated');
      return this.metaCache;
    } catch (error) {
      logger.error({ error }, 'Failed to fetch meta');
      if (this.metaCache.size > 0) return this.metaCache;
      throw error;
    }
  }

  async getAllMids(): Promise<Map<string, number>> {
    try {
      const response = await fetch(`${BASE_URL}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' } as AllMidsRequest),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as AllMidsResponse;
      const mids = new Map<string, number>();
      
      for (const [symbol, price] of Object.entries(data)) {
        mids.set(symbol, parseFloat(price));
      }
      
      return mids;
    } catch (error) {
      logger.error({ error }, 'Failed to fetch all mids');
      throw error;
    }
  }

  async getUserFills(userAddress: string, startTime?: number): Promise<UserFill[]> {
    try {
      const response = await fetch(`${BASE_URL}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'fills',
          user: userAddress,
          startTime,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as UserFillsResponse;
      return data.fills || [];
    } catch (error) {
      logger.error({ error, userAddress }, 'Failed to fetch user fills');
      return [];
    }
  }

  async getUserState(userAddress: string): Promise<UserStateResponse | null> {
    try {
      const response = await fetch(`${BASE_URL}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'userState',
          user: userAddress,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.json() as UserStateResponse;
    } catch (error) {
      logger.error({ error, userAddress }, 'Failed to fetch user state');
      return null;
    }
  }

  async getOrderFills(userAddress: string, oid: string): Promise<UserFill[]> {
    try {
      const response = await fetch(`${BASE_URL}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'orderFills',
          user: userAddress,
          oid,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as OrderFillsResponse;
      return data.fills || [];
    } catch (error) {
      logger.error({ error, userAddress, oid }, 'Failed to fetch order fills');
      return [];
    }
  }

  async getLeaderboard(page: number = 0, limit: number = 50): Promise<Array<{ user: string; pnl: number; volume: number; }>> {
    try {
      const response = await fetch(`${BASE_URL}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'leaderboard',
          page,
          limit,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as { data?: Array<{ user: string; pnl: number; volume: number; }> };
      return data.data || [];
    } catch (error) {
      logger.error({ error }, 'Failed to fetch leaderboard');
      return [];
    }
  }
}