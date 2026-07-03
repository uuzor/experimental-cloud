import 'dotenv/config';
import { logger } from './utils/logger.js';
import { HyperliquidApi } from './hyperliquid/api.js';
import { HyperliquidWebSocket } from './hyperliquid/websocket.js';
import { TraderStore } from './hyperliquid/store.js';
import { SignalPublisher } from './publisher/index.js';
import { SignalDetector } from './detector/index.js';
import { Scheduler } from './scheduler/index.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL || '30000', 10);

async function main() {
  logger.info('Starting Signal Tracker...');

  // Initialize components
  const api = new HyperliquidApi();
  const ws = new HyperliquidWebSocket();
  const store = new TraderStore();
  const publisher = new SignalPublisher(REDIS_URL);
  const scheduler = new Scheduler();

  try {
    // Connect to Redis
    await publisher.connect();
    logger.info('Connected to Redis');

    // Start signal detector
    const detector = new SignalDetector(api, store, publisher);
    await detector.start();
    logger.info('Signal detector started');

    // Start scheduler
    scheduler.start();

    // Schedule periodic tasks
    scheduler.schedule('refresh-top-traders', 5 * 60 * 1000, async () => {
      logger.debug('Refreshing top traders...');
      // The detector handles this internally
    });

    // Heartbeat to backend
    const heartbeat = setInterval(async () => {
      try {
        const response = await fetch(`${BACKEND_URL}/api/internal/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            service: 'signal-tracker',
            timestamp: Date.now(),
            traders: store.getAllTradersCount(),
            topTraders: store.getTopTraders().length,
          }),
        });

        if (!response.ok) {
          logger.warn({ status: response.status }, 'Heartbeat failed');
        }
      } catch (error) {
        logger.debug({ error }, 'Heartbeat skipped (backend may not be running)');
      }
    }, HEARTBEAT_INTERVAL);

    logger.info({
      redisUrl: REDIS_URL,
      backendUrl: BACKEND_URL,
      heartbeatInterval: HEARTBEAT_INTERVAL,
    }, 'Signal Tracker running');

    // Graceful shutdown
    const shutdown = async () => {
      logger.info('Shutting down...');
      clearInterval(heartbeat);
      detector.stop();
      scheduler.stop();
      ws.disconnect();
      await publisher.disconnect();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (error) {
    logger.error({ error }, 'Fatal error');
    await publisher.disconnect();
    process.exit(1);
  }
}

main();