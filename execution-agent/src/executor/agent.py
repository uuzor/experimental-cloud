"""Trading executor with signal filtering."""

import asyncio
import random
from typing import Optional
import structlog

from ..hyperliquid.client import HyperliquidClient
from ..subscriber.redis_subscriber import SignalSubscriber
from ..types import TradingSignal, CopyTradeConfig

logger = structlog.get_logger(__name__)


class TradingExecutor:
    """Executes trades based on received signals with filtering."""

    def __init__(
        self,
        redis_url: str,
        hl_client: HyperliquidClient,
        config: CopyTradeConfig,
        subscribed_traders: Optional[list[str]] = None,
    ):
        """Initialize the trading executor.

        Args:
            redis_url: Redis connection URL
            hl_client: Hyperliquid client
            config: Trading configuration
            subscribed_traders: List of trader addresses to follow (per-user)
        """
        self.redis_url = redis_url
        self.hl_client = hl_client
        self.config = config
        self.subscribed_traders = subscribed_traders or []
        self.subscriber = SignalSubscriber(redis_url)
        self._running = False
        
        # Register signal handler
        self.subscriber.on_signal(self._process_signal)
        
        logger.info(
            "Trading executor initialized",
            subscribed_traders=len(self.subscribed_traders),
            config=config,
        )

    async def start(self) -> None:
        """Start the executor."""
        await self.subscriber.connect()
        await self.subscriber.subscribe()
        self._running = True
        logger.info("Trading executor started")
        
        # Start listening in background
        asyncio.create_task(self.subscriber.listen())

    async def stop(self) -> None:
        """Stop the executor."""
        self._running = False
        await self.subscriber.stop()
        await self.subscriber.disconnect()
        logger.info("Trading executor stopped")

    async def _process_signal(self, signal: TradingSignal) -> None:
        """Process a received trading signal.

        Args:
            signal: The trading signal to process
        """
        logger.debug(
            "Processing signal",
            signal_id=signal.signal_id,
            trader=signal.trader_address,
            symbol=signal.symbol,
            side=signal.side,
            action=signal.action,
        )

        # FILTER 1: Check if we subscribe to this trader
        if self.subscribed_traders:
            if signal.trader_address not in self.subscribed_traders:
                logger.debug(
                    "Ignoring signal - trader not subscribed",
                    trader=signal.trader_address,
                    subscribed=self.subscribed_traders,
                )
                return

        # FILTER 2: Check if symbol is allowed
        if self.config.allowed_symbols and signal.symbol not in self.config.allowed_symbols:
            logger.debug(
                "Ignoring signal - symbol not allowed",
                symbol=signal.symbol,
                allowed=self.config.allowed_symbols,
            )
            return

        # FILTER 3: Check risk limits
        risk_check = self._check_risk_limits(signal)
        if not risk_check.passed:
            logger.info(
                "Ignoring signal - risk limit",
                reason=risk_check.reason,
                signal_id=signal.signal_id,
            )
            return

        # Apply jitter (0-250ms) to reduce thundering herd
        jitter_ms = random.randint(0, 250)
        await asyncio.sleep(jitter_ms / 1000)
        logger.debug("Applied jitter", jitter_ms=jitter_ms)

        # Execute the trade
        try:
            await self._execute_trade(signal)
        except Exception as e:
            logger.error(
                "Trade execution failed",
                signal_id=signal.signal_id,
                error=str(e),
            )

    def _check_risk_limits(self, signal: TradingSignal) -> tuple:
        """Check if signal passes risk limits."""
        from dataclasses import dataclass
        
        @dataclass
        class RiskCheck:
            passed: bool
            reason: Optional[str] = None
        
        # Check leverage
        if signal.leverage > self.config.max_leverage:
            return RiskCheck(False, f"Leverage {signal.leverage} exceeds max {self.config.max_leverage}")
        
        # Check position size
        position_value = signal.size * signal.entry_price
        if position_value > self.config.max_position_size_usd:
            return RiskCheck(False, f"Position ${position_value:.2f} exceeds max ${self.config.max_position_size_usd}")
        
        # Check position percentage
        if hasattr(self.config, 'max_position_pct'):
            if signal.size > self.config.max_position_pct:
                return RiskCheck(False, f"Size {signal.size} exceeds max {self.config.max_position_pct}")
        
        return RiskCheck(True)

    async def _execute_trade(self, signal: TradingSignal) -> None:
        """Execute a trade based on signal."""
        logger.info(
            "Executing trade",
            signal_id=signal.signal_id,
            symbol=signal.symbol,
            side=signal.side,
            size=signal.size,
            price=signal.entry_price,
        )

        # Convert side to Hyperliquid format
        side_hl = "Buy" if signal.side == "long" else "Sell"

        # Place order
        order_result = await self.hl_client.place_order(
            symbol=signal.symbol,
            side=side_hl,
            size=signal.size,
            price=signal.entry_price,
            reduce_only=(signal.action == "close"),
        )

        logger.info(
            "Order placed",
            order_id=order_result.get("orderId"),
            status=order_result.get("status"),
        )

    def update_subscriptions(self, traders: list[str]) -> None:
        """Update the list of subscribed traders.
        
        Args:
            traders: New list of trader addresses to follow
        """
        self.subscribed_traders = traders
        logger.info("Updated subscribed traders", count=len(traders))
