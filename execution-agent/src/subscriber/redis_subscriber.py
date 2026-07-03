"""Redis subscriber for trading signals.

Listens to the trading_signals channel and processes incoming signals.
"""

import asyncio
import json
import redis.asyncio as redis
from typing import Callable, Awaitable
import structlog

from ..types import TradingSignal

logger = structlog.get_logger(__name__)

SIGNAL_CHANNEL = "trading_signals"
TOP_TRADERS_CHANNEL = "top_traders"


class SignalSubscriber:
    """Subscribes to trading signals from Redis."""

    def __init__(self, redis_url: str):
        """Initialize the signal subscriber.
        
        Args:
            redis_url: Redis connection URL (e.g., redis://localhost:6379)
        """
        self.redis_url = redis_url
        self._redis: redis.Redis | None = None
        self._pubsub: redis.client.PubSub | None = None
        self._running = False
        self._handlers: list[Callable[[TradingSignal], Awaitable[None]]] = []

    async def connect(self) -> None:
        """Connect to Redis."""
        self._redis = redis.from_url(
            self.redis_url,
            encoding="utf-8",
            decode_responses=True,
        )
        self._pubsub = self._redis.pubsub()
        logger.info("Connected to Redis", url=self.redis_url)

    async def disconnect(self) -> None:
        """Disconnect from Redis."""
        self._running = False
        
        if self._pubsub:
            await self._pubsub.close()
            self._pubsub = None
            
        if self._redis:
            await self._redis.close()
            self._redis = None
            
        logger.info("Disconnected from Redis")

    def on_signal(self, handler: Callable[[TradingSignal], Awaitable[None]]) -> None:
        """Register a handler for incoming signals.
        
        Args:
            handler: Async function that processes the signal
        """
        self._handlers.append(handler)

    async def subscribe(self) -> None:
        """Subscribe to the trading signals channel."""
        if not self._pubsub:
            raise RuntimeError("Not connected to Redis")
            
        await self._pubsub.subscribe(SIGNAL_CHANNEL)
        logger.info("Subscribed to signal channel", channel=SIGNAL_CHANNEL)

    async def listen(self) -> None:
        """Start listening for signals.
        
        This is a blocking call that runs until stop() is called.
        """
        if not self._pubsub:
            raise RuntimeError("Not connected to Redis")
            
        self._running = True
        logger.info("Starting signal listener...")
        
        while self._running:
            try:
                message = await self._pubsub.get_message(
                    ignore_subscribe_messages=True,
                    timeout=1.0,
                )
                
                if message is None:
                    await asyncio.sleep(0.1)
                    continue
                    
                if message["type"] == "message":
                    await self._handle_message(message["data"])
                    
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Error processing message", error=str(e))
                await asyncio.sleep(1)  # Back off on error

    async def stop(self) -> None:
        """Stop the listener."""
        self._running = False

    async def _handle_message(self, data: str) -> None:
        """Handle an incoming message.
        
        Args:
            data: Raw message data
        """
        try:
            parsed = json.loads(data)
            
            if parsed.get("type") == "signal":
                signal_data = parsed.get("data", {})
                signal = self._parse_signal(signal_data)
                
                if signal:
                    logger.debug(
                        "Received signal",
                        signal_id=signal.signal_id,
                        symbol=signal.symbol,
                        side=signal.side,
                    )
                    
                    # Process with all handlers
                    for handler in self._handlers:
                        try:
                            await handler(signal)
                        except Exception as e:
                            logger.error(
                                "Handler error",
                                handler=handler.__name__,
                                error=str(e),
                            )
                else:
                    logger.warn("Failed to parse signal", data=signal_data)
                    
        except json.JSONDecodeError as e:
            logger.error("Invalid JSON in message", error=str(e), data=data)

    def _parse_signal(self, data: dict) -> TradingSignal | None:
        """Parse signal data into a TradingSignal object."""
        try:
            return TradingSignal(
                signal_id=data.get("trade_hash", ""),
                trader_address=data.get("traderAddress", ""),
                trader_pnl_percent=float(data.get("traderPnlPercent", 0)),
                trader_drawdown=float(data.get("traderDrawdown", 0)),
                trader_win_rate=float(data.get("traderWinRate", 0)),
                symbol=data.get("symbol", ""),
                side=data.get("side", ""),
                entry_price=float(data.get("entryPrice", 0)),
                current_price=float(data.get("currentPrice", 0)),
                size=float(data.get("size", 0)),
                leverage=int(data.get("leverage", 1)),
                unrealized_pnl_percent=float(data.get("unrealizedPnlPercent", 0)),
                timestamp=int(data.get("timestamp", 0)),
                trade_hash=data.get("tradeHash", ""),
            )
        except (ValueError, TypeError) as e:
            logger.error("Signal parse error", error=str(e), data=data)
            return None


class TopTradersSubscriber:
    """Subscribes to top traders updates from Redis."""

    def __init__(self, redis_url: str):
        """Initialize the top traders subscriber."""
        self.redis_url = redis_url
        self._redis: redis.Redis | None = None
        self._pubsub: redis.client.PubSub | None = None
        self._running = False
        self._handlers: list[Callable[[list[dict]], Awaitable[None]]] = []

    async def connect(self) -> None:
        """Connect to Redis."""
        self._redis = redis.from_url(
            self.redis_url,
            encoding="utf-8",
            decode_responses=True,
        )
        self._pubsub = self._redis.pubsub()
        logger.info("Connected to Redis", url=self.redis_url)

    async def disconnect(self) -> None:
        """Disconnect from Redis."""
        self._running = False
        
        if self._pubsub:
            await self._pubsub.close()
            self._pubsub = None
            
        if self._redis:
            await self._redis.close()
            self._redis = None

    def on_update(self, handler: Callable[[list[dict]], Awaitable[None]]) -> None:
        """Register a handler for top traders updates."""
        self._handlers.append(handler)

    async def subscribe(self) -> None:
        """Subscribe to the top traders channel."""
        if not self._pubsub:
            raise RuntimeError("Not connected to Redis")
            
        await self._pubsub.subscribe(TOP_TRADERS_CHANNEL)
        logger.info("Subscribed to top traders channel", channel=TOP_TRADERS_CHANNEL)

    async def listen(self) -> None:
        """Start listening for updates."""
        if not self._pubsub:
            raise RuntimeError("Not connected to Redis")
            
        self._running = True
        logger.info("Starting top traders listener...")
        
        while self._running:
            try:
                message = await self._pubsub.get_message(
                    ignore_subscribe_messages=True,
                    timeout=1.0,
                )
                
                if message is None:
                    await asyncio.sleep(0.1)
                    continue
                    
                if message["type"] == "message":
                    await self._handle_message(message["data"])
                    
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Error processing message", error=str(e))
                await asyncio.sleep(1)

    async def stop(self) -> None:
        """Stop the listener."""
        self._running = False

    async def _handle_message(self, data: str) -> None:
        """Handle an incoming message."""
        try:
            parsed = json.loads(data)
            
            if parsed.get("type") == "top_traders":
                traders = parsed.get("data", [])
                
                logger.debug(
                    "Received top traders update",
                    count=len(traders),
                )
                
                for handler in self._handlers:
                    try:
                        await handler(traders)
                    except Exception as e:
                        logger.error("Handler error", error=str(e))
                        
        except json.JSONDecodeError as e:
            logger.error("Invalid JSON in message", error=str(e), data=data)