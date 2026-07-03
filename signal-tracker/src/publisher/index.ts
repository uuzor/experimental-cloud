import { Redis } from 'ioredis';
import { createLogger } from '../utils/logger.js';
import { SIGNAL_CHANNEL, TOP_TRADERS_CHANNEL, TradingSignal, TopTrader } from '../types/index.js';

const logger = createLogger('redis-publisher');

export class SignalPublisher {
  private publisher!: Redis;
  private subscriber!: Redis;
  private isConnected = false;

  constructor(redisUrl: string) {
    this.publisher = new Redis(redisUrl, { lazyConnect: true });
    this.subscriber = new Redis(redisUrl, { lazyConnect: true });

    this.publisher.on('error', (error: Error) => {
      logger.error({ error }, 'Publisher error');
    });

    this.subscriber.on('error', (error: Error) => {
      logger.error({ error }, 'Subscriber error');
    });

    this.publisher.on('connect', () => {
      logger.info('Redis publisher connected');
      this.isConnected = true;
    });
  }

  async connect(): Promise<void> {
    await this.publisher.connect();
    await this.subscriber.connect();
  }

  async disconnect(): Promise<void> {
    await this.publisher.quit();
    await this.subscriber.quit();
    this.isConnected = false;
  }

  async publishSignal(signal: TradingSignal): Promise<void> {
    if (!this.isConnected) {
      logger.warn('Publisher not connected, skipping signal');
      return;
    }

    try {
      await this.publisher.publish(
        SIGNAL_CHANNEL,
        JSON.stringify({
          type: 'signal',
          data: signal,
          timestamp: Date.now(),
        })
      );
      logger.debug({ signal }, 'Signal published');
    } catch (error) {
      logger.error({ error, signal }, 'Failed to publish signal');
    }
  }

  async publishTopTraders(traders: TopTrader[]): Promise<void> {
    if (!this.isConnected) {
      logger.warn('Publisher not connected, skipping top traders');
      return;
    }

    try {
      await this.publisher.publish(
        TOP_TRADERS_CHANNEL,
        JSON.stringify({
          type: 'top_traders',
          data: traders,
          timestamp: Date.now(),
        })
      );
      logger.debug({ count: traders.length }, 'Top traders published');
    } catch (error) {
      logger.error({ error }, 'Failed to publish top traders');
    }
  }

  onTopTradersUpdate(callback: (traders: TopTrader[]) => void): void {
    this.subscriber.subscribe(TOP_TRADERS_CHANNEL).then(() => {
      logger.info('Subscribed to top traders channel');
    }).catch((err: Error) => {
      logger.error({ error: err }, 'Failed to subscribe to top traders');
    });

    this.subscriber.on('message', (channel: string, message: string) => {
      if (channel === TOP_TRADERS_CHANNEL) {
        try {
          const parsed = JSON.parse(message);
          if (parsed.type === 'top_traders') {
            callback(parsed.data);
          }
        } catch (error) {
          logger.error({ error, message }, 'Failed to parse top traders message');
        }
      }
    });
  }
}