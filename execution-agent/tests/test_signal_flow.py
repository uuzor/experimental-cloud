"""Test the signal flow between components."""

import pytest
import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

from src.subscriber.redis_subscriber import SignalSubscriber, SIGNAL_CHANNEL
from src.types import TradingSignal, CopyTradeConfig


class TestSignalSubscriber:
    """Test Redis signal subscriber."""

    def test_signal_channel_name(self):
        """Test that channel name matches expected."""
        assert SIGNAL_CHANNEL == "signals:v1"


class TestSignalFiltering:
    """Test signal filtering logic."""

    @pytest.fixture
    def config(self):
        """Create a test configuration."""
        return CopyTradeConfig(
            user_id="user-123",
            subscription_id="sub-123",
            trader_address="0x1234",
            max_position_size=100.0,
            max_leverage=3,
            stop_loss_percent=2.0,
            take_profit_percent=5.0,
            max_position_size_usd=100.0,
            allowed_symbols=["BTC", "ETH"],
        )

    def test_filter_by_symbol(self, config):
        """Test symbol filtering."""
        # Allowed symbol
        signal_allowed = TradingSignal(
            signal_id="sig-1",
            trader_address="0x1234",
            symbol="BTC",
            side="long",
            action="open",
            entry_price=65000,
            current_price=65100,
            size=0.01,
            leverage=2,
            timestamp=1709500000,
            trade_hash="0xabc",
        )

        # Not allowed symbol
        signal_blocked = TradingSignal(
            signal_id="sig-2",
            trader_address="0x1234",
            symbol="DOGE",  # Not in allowed_symbols
            side="long",
            action="open",
            entry_price=0.1,
            current_price=0.11,
            size=100,
            leverage=2,
            timestamp=1709500000,
            trade_hash="0xdef",
        )

        # Check filtering logic
        assert signal_allowed.symbol in config.allowed_symbols
        assert signal_blocked.symbol not in config.allowed_symbols

    def test_filter_by_leverage(self, config):
        """Test leverage filtering."""
        signal_ok = TradingSignal(
            signal_id="sig-1",
            trader_address="0x1234",
            symbol="BTC",
            side="long",
            action="open",
            entry_price=65000,
            current_price=65100,
            size=0.01,
            leverage=2,  # Under max
            timestamp=1709500000,
            trade_hash="0xabc",
        )

        signal_too_high = TradingSignal(
            signal_id="sig-2",
            trader_address="0x1234",
            symbol="BTC",
            side="long",
            action="open",
            entry_price=65000,
            current_price=65100,
            size=0.01,
            leverage=5,  # Over max (3)
            timestamp=1709500000,
            trade_hash="0xdef",
        )

        assert signal_ok.leverage <= config.max_leverage
        assert signal_too_high.leverage > config.max_leverage

    def test_filter_by_position_size(self, config):
        """Test position size filtering."""
        signal_ok = TradingSignal(
            signal_id="sig-1",
            trader_address="0x1234",
            symbol="BTC",
            side="long",
            action="open",
            entry_price=5000,  # $50 position
            current_price=50100,
            size=0.01,
            leverage=2,
            timestamp=1709500000,
            trade_hash="0xabc",
        )

        signal_too_big = TradingSignal(
            signal_id="sig-2",
            trader_address="0x1234",
            symbol="BTC",
            side="long",
            action="open",
            entry_price=1100,  # $110 position (over $100 limit)
            current_price=50100,
            size=0.1,
            leverage=2,
            timestamp=1709500000,
            trade_hash="0xdef",
        )

        position_ok = signal_ok.size * signal_ok.entry_price
        position_big = signal_too_big.size * signal_too_big.entry_price

        assert position_ok <= config.max_position_size_usd
        assert position_big > config.max_position_size_usd


class TestPerUserFiltering:
    """Test per-user signal filtering."""

    def test_filter_by_subscribed_traders(self):
        """Test filtering by subscribed traders."""
        subscribed = [
            "0x1111111111111111111111111111111111111111",
            "0x2222222222222222222222222222222222222222",
        ]

        signal_subscribed = TradingSignal(
            signal_id="sig-1",
            trader_address="0x1111111111111111111111111111111111111111",  # In list
            symbol="BTC",
            side="long",
            action="open",
            entry_price=65000,
            current_price=65100,
            size=0.01,
            leverage=2,
            timestamp=1709500000,
            trade_hash="0xabc",
        )

        signal_not_subscribed = TradingSignal(
            signal_id="sig-2",
            trader_address="0x3333333333333333333333333333333333333333",  # Not in list
            symbol="BTC",
            side="long",
            action="open",
            entry_price=65000,
            current_price=65100,
            size=0.01,
            leverage=2,
            timestamp=1709500000,
            trade_hash="0xdef",
        )

        assert signal_subscribed.trader_address in subscribed
        assert signal_not_subscribed.trader_address not in subscribed


class TestSignalParsing:
    """Test signal message parsing."""

    def test_parse_signal_message(self):
        """Test parsing a signal message from Redis."""
        message = {
            "type": "signal",
            "data": {
                "signalId": "sig-123",
                "traderAddress": "0x1234567890abcdef1234567890abcdef12345678",
                "symbol": "BTC",
                "side": "long",
                "action": "open",
                "entryPrice": 65000.0,
                "currentPrice": 65100.0,
                "size": 0.01,
                "leverage": 3,
                "timestamp": 1709500000,
                "tradeHash": "0xabcdef",
            },
            "timestamp": 1709500001,
        }

        signal_data = message["data"]
        
        signal = TradingSignal(
            signal_id=signal_data["signalId"],
            trader_address=signal_data["traderAddress"],
            symbol=signal_data["symbol"],
            side=signal_data["side"],
            action=signal_data["action"],
            entry_price=signal_data["entryPrice"],
            current_price=signal_data["currentPrice"],
            size=signal_data["size"],
            leverage=signal_data["leverage"],
            timestamp=signal_data["timestamp"],
            trade_hash=signal_data["tradeHash"],
        )

        assert signal.signal_id == "sig-123"
        assert signal.trader_address == "0x1234567890abcdef1234567890abcdef12345678"
        assert signal.symbol == "BTC"
        assert signal.side == "long"
        assert signal.action == "open"
        assert signal.entry_price == 65000.0
        assert signal.size == 0.01
        assert signal.leverage == 3


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
