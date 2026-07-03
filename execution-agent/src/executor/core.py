"""Core trading executor.

This module handles:
1. Converting signals to orders
2. Position management (entry, exit, SL/TP)
3. Risk management (max position size, leverage limits)
4. Order execution and tracking
"""

import asyncio
import time
from typing import Optional
from dataclasses import dataclass, field
from enum import Enum
import structlog

from ..types import (
    TradingSignal,
    OrderSide,
    OrderType,
    OrderResult,
    Position,
    CopyTradeConfig,
    ExecutorMetrics,
)
from ..hyperliquid.client import (
    HyperliquidClient,
    generate_cloid,
    price_to_precision,
    size_to_precision,
)

logger = structlog.get_logger(__name__)


class RiskLimit(Enum):
    """Risk limit exceeded."""
    MAX_POSITION_SIZE = "max_position_size"
    MAX_LEVERAGE = "max_leverage"
    STOP_LOSS_EXCEEDED = "stop_loss_exceeded"
    INSUFFICIENT_BALANCE = "insufficient_balance"


@dataclass
class PositionState:
    """Current position state."""
    symbol: str
    side: str
    size: float
    entry_price: float
    current_price: float
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None
    order_id: Optional[str] = None
    opened_at: int = field(default_factory=lambda: int(time.time() * 1000))


class TradingExecutor:
    """Executes trades based on signals with risk management."""

    def __init__(
        self,
        client: HyperliquidClient,
        config: CopyTradeConfig,
        meta: dict,
    ):
        """Initialize the trading executor.
        
        Args:
            client: Hyperliquid API client
            config: Copy trading configuration
            meta: Asset metadata from Hyperliquid
        """
        self.client = client
        self.config = config
        self.meta = meta
        
        self.positions: dict[str, PositionState] = {}
        self.metrics = ExecutorMetrics()
        self._last_prices: dict[str, float] = {}

    async def process_signal(self, signal: TradingSignal) -> Optional[OrderResult]:
        """Process a trading signal and execute if valid.
        
        Args:
            signal: The trading signal to process
            
        Returns:
            OrderResult if order was submitted, None if skipped
        """
        self.metrics.signals_processed += 1
        self.metrics.last_signal_at = signal.timestamp

        # Check if this signal is for a subscribed trader
        if signal.trader_address != self._get_trader_address():
            logger.debug(
                "Signal not for subscribed trader",
                signal_trader=signal.trader_address,
                subscribed=self.config.trader_address,
            )
            return None

        # Check if copying is enabled
        if not self.config.enabled:
            logger.debug("Copy trading disabled")
            return None

        # Validate signal quality
        risk_check = self._check_risk_limits(signal)
        if risk_check is not None:
            logger.info(
                "Signal rejected by risk management",
                signal_id=signal.signal_id,
                reason=risk_check.value,
            )
            return None

        # Get or update current position
        position = self.positions.get(signal.symbol)
        
        if position is None:
            # Open new position
            return await self._open_position(signal)
        else:
            # Update or close existing position
            return await self._manage_position(signal, position)

    def _check_risk_limits(self, signal: TradingSignal) -> Optional[RiskLimit]:
        """Check if signal passes risk management rules."""
        # Check leverage
        if signal.leverage > self.config.max_leverage:
            return RiskLimit.MAX_LEVERAGE

        # Check position size
        if signal.size > self.config.max_position_size:
            return RiskLimit.MAX_POSITION_SIZE

        # Check stop loss
        if signal.unrealized_pnl_percent < -self.config.stop_loss_percent:
            return RiskLimit.STOP_LOSS_EXCEEDED

        return None

    async def _open_position(self, signal: TradingSignal) -> OrderResult:
        """Open a new position based on signal."""
        try:
            # Get asset decimals
            decimals = self._get_asset_decimals(signal.symbol)
            
            # Prepare order
            size_str = size_to_precision(signal.size, decimals)
            
            # Calculate SL/TP prices
            entry_price = signal.entry_price
            stop_loss = self._calculate_stop_loss(entry_price, signal.side, decimals)
            take_profit = self._calculate_take_profit(entry_price, signal.side, decimals)
            
            # Generate client order ID
            cloid = generate_cloid()
            
            # Place order
            side = "B" if signal.side == "long" else "A"
            
            result = await self.client.place_order(
                coin=signal.symbol,
                side=side,
                sz=size_str,
                px=price_to_precision(entry_price, self._get_tick_size(signal.symbol)),
                order_type="limit",
                cloid=cloid,
            )
            
            # Check result
            if result.get("status") == "ok":
                response = result.get("response", {})
                statuses = response.get("data", {}).get("statuses", [])
                
                order_info = statuses[0] if statuses else {}
                order_id = order_info.get("resting", {}).get("oid")
                
                # Store position
                self.positions[signal.symbol] = PositionState(
                    symbol=signal.symbol,
                    side=signal.side,
                    size=signal.size,
                    entry_price=entry_price,
                    current_price=entry_price,
                    stop_loss=stop_loss,
                    take_profit=take_profit,
                    order_id=order_id,
                )
                
                self.metrics.orders_submitted += 1
                self.metrics.last_order_at = int(time.time() * 1000)
                
                logger.info(
                    "Position opened",
                    symbol=signal.symbol,
                    side=signal.side,
                    size=signal.size,
                    entry_price=entry_price,
                    order_id=order_id,
                )
                
                return OrderResult(
                    success=True,
                    order_id=order_id,
                    status="submitted",
                    fills=[],
                )
            else:
                error = result.get("error", "Unknown error")
                self.metrics.orders_failed += 1
                
                return OrderResult(
                    success=False,
                    error=error,
                )
                
        except Exception as e:
            logger.error("Failed to open position", error=str(e), signal=signal)
            self.metrics.orders_failed += 1
            
            return OrderResult(
                success=False,
                error=str(e),
            )

    async def _manage_position(
        self,
        signal: TradingSignal,
        position: PositionState,
    ) -> Optional[OrderResult]:
        """Manage an existing position based on signal."""
        # Check if signal indicates to close
        if signal.side != position.side or signal.unrealized_pnl_percent >= self.config.take_profit_percent:
            return await self._close_position(position, "signal")
        
        # Check stop loss
        current_pnl = signal.unrealized_pnl_percent
        if current_pnl <= -self.config.stop_loss_percent:
            return await self._close_position(position, "stop_loss")
        
        # Check take profit
        if current_pnl >= self.config.take_profit_percent:
            return await self._close_position(position, "take_profit")
        
        # Update current price
        position.current_price = signal.current_price
        
        return None

    async def _close_position(
        self,
        position: PositionState,
        reason: str,
    ) -> OrderResult:
        """Close an existing position."""
        try:
            # Get asset decimals
            decimals = self._get_asset_decimals(position.symbol)
            
            # Place market close order
            side = "A" if position.side == "long" else "B"
            
            result = await self.client.place_order(
                coin=position.symbol,
                side=side,
                sz=size_to_precision(position.size, decimals),
                order_type="market",
                reduce_only=True,
            )
            
            if result.get("status") == "ok":
                # Remove position
                del self.positions[position.symbol]
                
                logger.info(
                    "Position closed",
                    symbol=position.symbol,
                    reason=reason,
                    entry_price=position.entry_price,
                    current_price=position.current_price,
                )
                
                self.metrics.orders_filled += 1
                
                return OrderResult(
                    success=True,
                    status="closed",
                )
            else:
                error = result.get("error", "Unknown error")
                return OrderResult(
                    success=False,
                    error=error,
                )
                
        except Exception as e:
            logger.error("Failed to close position", error=str(e), position=position)
            return OrderResult(
                success=False,
                error=str(e),
            )

    def _calculate_stop_loss(
        self,
        entry_price: float,
        side: str,
        decimals: int,
    ) -> float:
        """Calculate stop loss price."""
        tick = self._get_tick_size_from_decimals(decimals)
        sl_percent = self.config.stop_loss_percent / 100
        
        if side == "long":
            sl_price = entry_price * (1 - sl_percent)
        else:
            sl_price = entry_price * (1 + sl_percent)
        
        # Round to tick size
        return round(sl_price / tick) * tick

    def _calculate_take_profit(
        self,
        entry_price: float,
        side: str,
        decimals: int,
    ) -> float:
        """Calculate take profit price."""
        tick = self._get_tick_size_from_decimals(decimals)
        tp_percent = self.config.take_profit_percent / 100
        
        if side == "long":
            tp_price = entry_price * (1 + tp_percent)
        else:
            tp_price = entry_price * (1 - tp_percent)
        
        # Round to tick size
        return round(tp_price / tick) * tick

    def _get_asset_decimals(self, coin: str) -> int:
        """Get size decimals for an asset."""
        for asset in self.meta.get("universe", []):
            if asset["name"] == coin:
                return asset.get("szDecimals", 4)
        return 4  # Default

    def _get_tick_size(self, coin: str) -> float:
        """Get tick size for an asset."""
        for asset in self.meta.get("universe", []):
            if asset["name"] == coin:
                # Convert index to tick size (approximation)
                index = asset.get("index", 0)
                return 0.1 ** (6 - min(index, 5))
        return 0.01  # Default

    def _get_tick_size_from_decimals(self, decimals: int) -> float:
        """Get tick size from decimals."""
        return 0.1 ** (6 - min(decimals, 5))

    def _get_trader_address(self) -> str:
        """Get the trader address being copied."""
        return self.config.trader_address

    def get_metrics(self) -> ExecutorMetrics:
        """Get current executor metrics."""
        return self.metrics

    def get_positions(self) -> dict[str, PositionState]:
        """Get current positions."""
        return self.positions.copy()