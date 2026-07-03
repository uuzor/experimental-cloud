"""Type definitions for the execution agent."""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, List
from datetime import datetime


class OrderSide(Enum):
    BUY = "buy"
    SELL = "sell"


class OrderType(Enum):
    MARKET = "market"
    LIMIT = "limit"
    STOP = "stop"
    TAKE_PROFIT = "take_profit"
    STOP_LOSS = "stop_loss"


class OrderStatus(Enum):
    PENDING = "pending"
    SUBMITTED = "submitted"
    FILLED = "filled"
    PARTIALLY_FILLED = "partially_filled"
    CANCELLED = "cancelled"
    REJECTED = "rejected"


class PositionStatus(Enum):
    OPEN = "open"
    CLOSED = "closed"
    LIQUIDATED = "liquidated"


@dataclass
class TradingSignal:
    """Signal from the signal tracker."""
    # Required fields first
    signal_id: str
    trader_address: str
    symbol: str
    side: str  # "long" or "short"
    entry_price: float
    current_price: float
    size: float
    leverage: int
    timestamp: int
    trade_hash: str
    # Optional fields (defaults)
    action: str = "open"  # "open", "close", "adjust"
    trader_pnl_percent: float = 0.0
    trader_drawdown: float = 0.0
    trader_win_rate: float = 0.0
    unrealized_pnl_percent: float = 0.0


@dataclass
class OrderRequest:
    """Order to be executed."""
    symbol: str
    side: OrderSide
    order_type: OrderType
    size: float
    price: Optional[float] = None
    reduce_only: bool = False
    slippage_tolerance: float = 0.005  # 0.5%


@dataclass
class Position:
    """Open position."""
    symbol: str
    side: str
    size: float
    entry_price: float
    current_price: float
    unrealized_pnl: float
    unrealized_pnl_percent: float
    leverage: int
    timestamp: int


@dataclass
class OrderResult:
    """Result of an order submission."""
    success: bool
    order_id: Optional[str] = None
    status: Optional[str] = None
    fills: list = field(default_factory=list)
    error: Optional[str] = None
    timestamp: int = 0

    def __post_init__(self):
        if self.timestamp == 0:
            self.timestamp = int(datetime.now().timestamp() * 1000)


@dataclass
class WalletState:
    """Agent wallet state."""
    address: str
    equity: float
    margin_used: float
    withdrawable: float
    positions: list = field(default_factory=list)
    open_orders: int = 0
    last_updated: int = 0


@dataclass
class CopyTradeConfig:
    """Configuration for copying a trader."""
    user_id: str
    subscription_id: str
    trader_address: str
    max_position_size: float
    max_leverage: int
    stop_loss_percent: float
    take_profit_percent: float
    enabled: bool = True
    # Extended config
    max_position_size_usd: float = 100.0
    allowed_symbols: List[str] = field(default_factory=lambda: ["BTC", "ETH"])
    max_position_pct: float = 0.1  # 10% of account


@dataclass
class ExecutorMetrics:
    """Metrics for the executor."""
    signals_processed: int = 0
    signals_rejected: int = 0
    orders_submitted: int = 0
    orders_filled: int = 0
    orders_failed: int = 0
    total_pnl: float = 0.0
    last_signal_at: Optional[int] = None
    last_order_at: Optional[int] = None
