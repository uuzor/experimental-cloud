import WebSocket from 'ws';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('hyperliquid-ws');

const WS_URL = 'wss://api.hyperliquid.xyz/ws';

interface WebSocketMessage {
  channel?: string;
  data?: unknown;
  error?: string;
}

interface Subscription {
  type: 'subscribe';
  subscription: { type: string; coin?: string; user?: string; };
}

type MessageHandler = (data: unknown) => void;

export class HyperliquidWebSocket {
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private subscriptions: Subscription[] = [];
  private isConnecting = false;
  private shouldReconnect = true;

  connect(): void {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.isConnecting = true;
    logger.info('Connecting to Hyperliquid WebSocket...');

    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      logger.info('WebSocket connected');
      this.isConnecting = false;
      this.reconnectAttempts = 0;

      // Resubscribe to all channels
      for (const sub of this.subscriptions) {
        this.send(JSON.stringify(sub));
      }
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString()) as WebSocketMessage;
        
        if (message.error) {
          logger.error({ error: message.error }, 'WebSocket error');
          return;
        }

        const channel = message.channel || 'unknown';
        const handlers = this.handlers.get(channel);
        
        if (handlers) {
          for (const handler of handlers) {
            try {
              handler(message.data);
            } catch (error) {
              logger.error({ error, channel }, 'Handler error');
            }
          }
        }
      } catch (error) {
        logger.error({ error }, 'Failed to parse WebSocket message');
      }
    });

    this.ws.on('close', () => {
      logger.warn('WebSocket disconnected');
      this.isConnecting = false;
      this.scheduleReconnect();
    });

    this.ws.on('error', (error) => {
      logger.error({ error }, 'WebSocket error');
      this.isConnecting = false;
    });
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectAttempts >= this.maxReconnectAttempts) {
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        logger.error('Max reconnection attempts reached');
      }
      return;
    }

    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    
    logger.info({ attempt: this.reconnectAttempts, delay }, 'Scheduling reconnection...');
    
    setTimeout(() => this.connect(), delay);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private send(message: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    }
  }

  subscribe(channel: string, sub: { type: string; coin?: string; user?: string; }): void {
    const subscription: Subscription = {
      type: 'subscribe',
      subscription: sub,
    };

    this.subscriptions.push(subscription);
    this.handlers.set(channel, this.handlers.get(channel) || new Set());
    
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send(JSON.stringify(subscription));
    }
  }

  on(channel: string, handler: MessageHandler): void {
    const handlers = this.handlers.get(channel) || new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
  }

  off(channel: string, handler: MessageHandler): void {
    const handlers = this.handlers.get(channel);
    if (handlers) {
      handlers.delete(handler);
    }
  }
}