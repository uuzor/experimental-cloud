"""Execution Agent - Main entry point.

This service:
1. Subscribes to trading signals from Redis
2. Manages agent wallets on Hyperliquid
3. Executes trades with proper risk management
4. Reports metrics back to the backend
"""

import asyncio
import signal
import os
from typing import Optional
from datetime import datetime
import structlog

from dotenv import load_dotenv
from .core import TradingExecutor
from ..subscriber.redis_subscriber import SignalSubscriber, TopTradersSubscriber
from ..hyperliquid.client import HyperliquidClient
from ..types import TradingSignal, CopyTradeConfig
from ..wallet.manager import WalletManager

# Load environment variables
load_dotenv()

logger = structlog.get_logger(__name__)


class ExecutionAgent:
    """Main execution agent that processes trading signals."""

    def __init__(self):
        """Initialize the execution agent."""
        # Configuration
        self.backend_url = os.getenv("BACKEND_URL", "http://localhost:3000")
        self.api_key = os.getenv("PLATFORM_API_KEY", "")
        self.agent_address = os.getenv("AGENT_ADDRESS", "")
        self.agent_private_key = os.getenv("AGENT_PRIVATE_KEY", "")
        self.redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
        
        # Initialize components
        self._client: Optional[HyperliquidClient] = None
        self._wallet_manager: Optional[WalletManager] = None
        self._signal_subscriber: Optional[SignalSubscriber] = None
        self._traders_subscriber: Optional[TopTradersSubscriber] = None
        self._executor: Optional[TradingExecutor] = None
        self._running = False
        self._meta: dict = {}

    async def start(self) -> None:
        """Start the execution agent."""
        logger.info("Starting execution agent...")
        
        # Validate configuration
        if not self.agent_address or not self.agent_private_key:
            raise ValueError("AGENT_ADDRESS and AGENT_PRIVATE_KEY are required")
        
        # Initialize Hyperliquid client
        self._client = HyperliquidClient(
            account_address=self.agent_address,
            secret_key=self.agent_private_key,
        )
        
        # Load asset metadata
        self._meta = await self._client.get_meta()
        logger.info("Loaded asset metadata", assets=len(self._meta.get("universe", [])))
        
        # Initialize wallet manager
        self._wallet_manager = WalletManager(
            backend_url=self.backend_url,
            api_key=self.api_key,
        )
        
        # Get copy trading config from backend
        config = await self._fetch_copy_config()
        
        # Initialize executor
        self._executor = TradingExecutor(
            client=self._client,
            config=config,
            meta=self._meta,
        )
        
        # Initialize Redis subscribers
        self._signal_subscriber = SignalSubscriber(self.redis_url)
        self._traders_subscriber = TopTradersSubscriber(self.redis_url)
        
        # Connect to Redis
        await self._signal_subscriber.connect()
        await self._traders_subscriber.connect()
        
        # Subscribe to channels
        await self._signal_subscriber.subscribe()
        await self._traders_subscriber.subscribe()
        
        # Register handlers
        self._signal_subscriber.on_signal(self._handle_signal)
        self._traders_subscriber.on_update(self._handle_top_traders)
        
        self._running = True
        
        # Start listeners
        asyncio.create_task(self._signal_subscriber.listen())
        asyncio.create_task(self._traders_subscriber.listen())
        
        # Start heartbeat
        asyncio.create_task(self._heartbeat_loop())
        
        logger.info(
            "Execution agent started",
            agent_address=self.agent_address,
            redis_url=self.redis_url,
        )

    async def stop(self) -> None:
        """Stop the execution agent."""
        logger.info("Stopping execution agent...")
        self._running = False
        
        # Stop subscribers
        if self._signal_subscriber:
            await self._signal_subscriber.stop()
            await self._signal_subscriber.disconnect()
            
        if self._traders_subscriber:
            await self._traders_subscriber.stop()
            await self._traders_subscriber.disconnect()
        
        # Close Hyperliquid client
        if self._client:
            await self._client.close()
        
        logger.info("Execution agent stopped")

    async def _handle_signal(self, signal_data: TradingSignal) -> None:
        """Handle an incoming trading signal."""
        logger.debug(
            "Processing signal",
            signal_id=signal_data.signal_id,
            symbol=signal_data.symbol,
            side=signal_data.side,
        )
        
        if self._executor:
            result = await self._executor.process_signal(signal_data)
            
            if result:
                logger.info(
                    "Signal processed",
                    success=result.success,
                    order_id=result.order_id,
                    error=result.error,
                )
                
                # Report to backend
                await self._report_order_result(result, signal_data)

    async def _handle_top_traders(self, traders: list[dict]) -> None:
        """Handle top traders update."""
        logger.debug("Top traders updated", count=len(traders))
        # Could trigger re-evaluation of subscriptions here

    async def _fetch_copy_config(self) -> CopyTradeConfig:
        """Fetch copy trading configuration from backend."""
        import httpx
        
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.backend_url}/api/internal/agents/{self.agent_address}/config",
                    headers={"X-API-Key": self.api_key},
                    timeout=10.0,
                )
                response.raise_for_status()
                data = response.json()
                
                return CopyTradeConfig(
                    user_id=data.get("user_id", ""),
                    subscription_id=data.get("subscription_id", ""),
                    trader_address=data.get("trader_address", ""),
                    max_position_size=float(data.get("max_position_size", 1.0)),
                    max_leverage=int(data.get("max_leverage", 10)),
                    stop_loss_percent=float(data.get("stop_loss_percent", 5.0)),
                    take_profit_percent=float(data.get("take_profit_percent", 10.0)),
                    enabled=data.get("enabled", True),
                )
        except httpx.HTTPError as e:
            logger.warn("Using default config", error=str(e))
            # Return default config
            return CopyTradeConfig(
                user_id="default",
                subscription_id="default",
                trader_address="",
                max_position_size=1.0,
                max_leverage=10,
                stop_loss_percent=5.0,
                take_profit_percent=10.0,
                enabled=False,
            )

    async def _report_order_result(
        self,
        result,
        signal: TradingSignal,
    ) -> None:
        """Report order result to backend."""
        import httpx
        
        try:
            async with httpx.AsyncClient() as client:
                await client.post(
                    f"{self.backend_url}/api/internal/agents/{self.agent_address}/orders",
                    json={
                        "signal_id": signal.signal_id,
                        "success": result.success,
                        "order_id": result.order_id,
                        "status": result.status,
                        "error": result.error,
                        "timestamp": result.timestamp,
                    },
                    headers={
                        "Content-Type": "application/json",
                        "X-API-Key": self.api_key,
                    },
                    timeout=10.0,
                )
        except httpx.HTTPError as e:
            logger.warn("Failed to report order", error=str(e))

    async def _heartbeat_loop(self) -> None:
        """Send periodic heartbeat to backend."""
        while self._running:
            try:
                await asyncio.sleep(30)  # Every 30 seconds
                
                if self._executor and self._running:
                    metrics = self._executor.get_metrics()
                    
                    import httpx
                    async with httpx.AsyncClient() as client:
                        await client.post(
                            f"{self.backend_url}/api/internal/heartbeat",
                            json={
                                "service": "execution-agent",
                                "agent_address": self.agent_address,
                                "timestamp": int(datetime.now().timestamp() * 1000),
                                "metrics": {
                                    "signals_processed": metrics.signals_processed,
                                    "orders_submitted": metrics.orders_submitted,
                                    "orders_filled": metrics.orders_filled,
                                    "orders_failed": metrics.orders_failed,
                                    "total_pnl": metrics.total_pnl,
                                },
                                "positions": len(self._executor.get_positions()),
                            },
                            headers={
                                "Content-Type": "application/json",
                                "X-API-Key": self.api_key,
                            },
                            timeout=10.0,
                        )
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Heartbeat failed", error=str(e))


async def main() -> None:
    """Main entry point."""
    structlog.configure(
        wrapper_class=structlog.make_filtering_bound_logger(
            int(os.getenv("LOG_LEVEL", "20"))  # INFO = 20
        ),
    )
    
    agent = ExecutionAgent()
    
    # Handle shutdown signals
    loop = asyncio.get_event_loop()
    
    def shutdown():
        asyncio.create_task(agent.stop())
        for task in asyncio.all_tasks(loop):
            task.cancel()
    
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, shutdown)
    
    try:
        await agent.start()
        
        # Keep running
        while agent._running:
            await asyncio.sleep(1)
            
    except asyncio.CancelledError:
        pass
    finally:
        await agent.stop()


if __name__ == "__main__":
    asyncio.run(main())