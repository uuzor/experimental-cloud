"""Hyperliquid API client wrapper.

This module provides a clean interface to the Hyperliquid exchange API,
including both info (read-only) and exchange (authenticated) endpoints.
"""

import time
import httpx
from typing import Optional
import structlog

logger = structlog.get_logger(__name__)

# Base URLs
INFO_URL = "https://api.hyperliquid.xyz/info"
EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange"
TESTNET_INFO_URL = "https://api.hyperliquid-testnet.xyz/info"
TESTNET_EXCHANGE_URL = "https://api.hyperliquid-testnet.xyz/exchange"


class HyperliquidClient:
    """Client for Hyperliquid API operations."""

    def __init__(
        self,
        account_address: str,
        secret_key: str,
        testnet: bool = False,
    ):
        """Initialize the Hyperliquid client.
        
        Args:
            account_address: The wallet address that owns this agent
            secret_key: The trading-only API key (not withdrawal key)
            testnet: Whether to use testnet
        """
        self.account_address = account_address
        self.secret_key = secret_key
        self.testnet = testnet
        
        self.info_url = TESTNET_INFO_URL if testnet else INFO_URL
        self.exchange_url = TESTNET_EXCHANGE_URL if testnet else EXCHANGE_URL
        
        self._http = httpx.AsyncClient(timeout=30.0)

    async def close(self):
        """Close the HTTP client."""
        await self._http.aclose()

    # -------------------------------------------------------------------------
    # Info Endpoints (no auth required)
    # -------------------------------------------------------------------------

    async def get_meta(self) -> dict:
        """Get asset metadata (names, tick sizes, etc)."""
        return await self._info_request({"type": "meta"})

    async def get_all_mids(self) -> dict[str, float]:
        """Get current mid prices for all assets."""
        data = await self._info_request({"type": "allMids"})
        return {k: float(v) for k, v in data.items()}

    async def get_leaderboard(
        self, 
        page: int = 0, 
        limit: int = 50
    ) -> list[dict]:
        """Get top traders leaderboard."""
        data = await self._info_request({
            "type": "leaderboard",
            "page": page,
            "limit": limit,
        })
        return data.get("data", [])

    async def get_user_state(self, user: str) -> Optional[dict]:
        """Get user's clearinghouse state (positions, margin, etc)."""
        return await self._info_request({
            "type": "userState",
            "user": user,
        })

    async def get_user_fills(
        self, 
        user: str, 
        start_time: Optional[int] = None
    ) -> list[dict]:
        """Get user's recent fills/trades."""
        payload = {"type": "fills", "user": user}
        if start_time:
            payload["startTime"] = start_time
        data = await self._info_request(payload)
        return data.get("fills", [])

    async def get_order_fills(
        self, 
        user: str, 
        oid: str
    ) -> list[dict]:
        """Get fills for a specific order."""
        data = await self._info_request({
            "type": "orderFills",
            "user": user,
            "oid": oid,
        })
        return data.get("fills", [])

    async def get_open_orders(self, user: str) -> list[dict]:
        """Get user's open orders."""
        data = await self._info_request({
            "type": "openOrders",
            "user": user,
        })
        return data or []

    async def get_order_status(
        self, 
        user: str, 
        oid: Optional[str] = None,
        cloid: Optional[str] = None
    ) -> Optional[dict]:
        """Get order status by order ID or client order ID."""
        payload = {"type": "orderStatus", "user": user}
        if oid:
            payload["oid"] = oid
        elif cloid:
            payload["cloid"] = cloid
        else:
            raise ValueError("Must provide either oid or cloid")
        return await self._info_request(payload)

    async def get_candles(
        self,
        coin: str,
        interval: str = "1h",
        start_time: Optional[int] = None,
        end_time: Optional[int] = None,
    ) -> list[dict]:
        """Get candlestick data."""
        payload = {
            "type": "candleSnapshot",
            "coin": coin,
            "interval": interval,
        }
        if start_time:
            payload["startTime"] = start_time
        if end_time:
            payload["endTime"] = end_time
        data = await self._info_request(payload)
        return data or []

    # -------------------------------------------------------------------------
    # Exchange Endpoints (requires signature)
    # -------------------------------------------------------------------------

    async def place_order(
        self,
        coin: str,
        side: str,  # "B" for buy, "A" for ask/sell
        sz: str,     # size as string
        px: Optional[str] = None,
        order_type: str = "limit",
        reduce_only: bool = False,
        cloid: Optional[str] = None,
        time_in_force: str = "Gtc",  # Gtc, Ioc, AltBm
    ) -> dict:
        """Place a single order.
        
        Args:
            coin: Asset symbol (e.g., "BTC", "ETH")
            side: "B" for buy, "A" for sell
            sz: Size as string
            px: Price as string (required for limit orders)
            order_type: "limit", "market", "stop", "trigger"
            reduce_only: Only reduce position
            cloid: Client order ID (128-bit hex)
            time_in_force: "Gtc", "Ioc", "AltBm"
        """
        order = {
            "a": coin,  # asset
            "b": side == "B",  # buy flag
            "p": px,
            "s": sz,
            "r": reduce_only,
            "t": order_type,
            "tif": time_in_force,
        }
        if cloid:
            order["cloid"] = cloid

        return await self._exchange_action(
            action_type="order",
            orders=[order],
        )

    async def batch_place_orders(
        self,
        orders: list[dict],
    ) -> dict:
        """Place multiple orders in a single request.
        
        Args:
            orders: List of order dicts with same fields as place_order
        """
        return await self._exchange_action(
            action_type="order",
            orders=orders,
        )

    async def modify_order(
        self,
        coin: str,
        oid: str,
        new_px: Optional[str] = None,
        new_sz: Optional[str] = None,
    ) -> dict:
        """Modify an existing order.
        
        Args:
            coin: Asset symbol
            oid: Order ID to modify
            new_px: New price (optional)
            new_sz: New size (optional)
        """
        modify = {"a": coin, "o": oid}
        if new_px:
            modify["p"] = new_px
        if new_sz:
            modify["s"] = new_sz
            
        return await self._exchange_action(
            action_type="modify",
            modifies=[modify],
        )

    async def cancel_order(
        self,
        coin: str,
        oid: str,
    ) -> dict:
        """Cancel an order.
        
        Args:
            coin: Asset symbol
            oid: Order ID to cancel
        """
        return await self._exchange_action(
            action_type="cancel",
            cancels=[{"a": coin, "o": oid}],
        )

    async def batch_cancel_orders(
        self,
        cancels: list[dict],
    ) -> dict:
        """Cancel multiple orders.
        
        Args:
            cancels: List of {"a": coin, "o": oid}
        """
        return await self._exchange_action(
            action_type="cancel",
            cancels=cancels,
        )

    async def update_leverage(
        self,
        coin: str,
        leverage: int,
        is_cross: bool = True,
    ) -> dict:
        """Update leverage for an asset.
        
        Args:
            coin: Asset symbol
            leverage: Leverage value (e.g., 1, 2, 10)
            is_cross: True for cross margin, False for isolated
        """
        return await self._exchange_action(
            action_type="updateLeverage",
            asset=coin,
            isCross=is_cross,
            leverage=leverage,
        )

    async def market_close(self, coin: str) -> dict:
        """Close a position at market price.
        
        Args:
            coin: Asset symbol
        """
        return await self._exchange_action(
            action_type="marketClose",
            coin=coin,
        )

    async def place_tp_sl_orders(
        self,
        coin: str,
        sz: str,
        tp_px: Optional[str] = None,
        sl_px: Optional[str] = None,
    ) -> dict:
        """Place take-profit and stop-loss orders together.
        
        Args:
            coin: Asset symbol
            sz: Size
            tp_px: Take-profit price
            sl_px: Stop-loss price
        """
        orders = []
        
        if tp_px:
            orders.append({
                "a": coin,
                "b": False,  # sell to close long
                "p": tp_px,
                "s": sz,
                "r": True,
                "t": "limit",
                "tif": "Gtc",
                "trigger": {"triggerPx": tp_px, "tpslMode": "tp"},
            })
        
        if sl_px:
            orders.append({
                "a": coin,
                "b": False,
                "p": sl_px,
                "s": sz,
                "r": True,
                "t": "limit",
                "tif": "Gtc",
                "trigger": {"triggerPx": sl_px, "tpslMode": "sl"},
            })
        
        if not orders:
            return {"status": "ok", "response": {"type": "empty"}}
            
        return await self._exchange_action(
            action_type="order",
            orders=orders,
        )

    # -------------------------------------------------------------------------
    # Private methods
    # -------------------------------------------------------------------------

    async def _info_request(self, payload: dict) -> dict:
        """Make an info API request."""
        try:
            response = await self._http.post(
                self.info_url,
                json=payload,
                headers={"Content-Type": "application/json"},
            )
            response.raise_for_status()
            data = response.json()
            
            if "error" in data:
                logger.error("Info request error", error=data["error"])
                raise Exception(data["error"])
                
            return data
        except httpx.HTTPError as e:
            logger.error("Info request failed", error=str(e))
            raise

    async def _exchange_action(
        self,
        action_type: str,
        orders: Optional[list] = None,
        modifies: Optional[list] = None,
        cancels: Optional[list] = None,
        **extra_fields,
    ) -> dict:
        """Make an exchange API request (requires signature).
        
        The signature is generated using the agent's trading-only private key.
        This key structurally cannot authorize withdrawals - only trading.
        """
        action = {"type": action_type, **extra_fields}
        
        if orders:
            action["orders"] = orders
        if modifies:
            action["modifies"] = modifies
        if cancels:
            action["cancels"] = cancels

        # Generate nonce (timestamp in milliseconds)
        nonce = str(int(time.time() * 1000))

        # Build the payload for signing
        payload_to_sign = {
            "action": action,
            "nonce": nonce,
        }

        # Sign the payload
        signature = self._sign_payload(payload_to_sign)

        # Make the request
        try:
            response = await self._http.post(
                self.exchange_url,
                json={
                    "action": action,
                    "nonce": nonce,
                    "signature": signature,
                },
                headers={"Content-Type": "application/json"},
            )
            response.raise_for_status()
            data = response.json()
            
            if "error" in data:
                logger.error("Exchange request error", error=data["error"])
                raise Exception(data["error"])
                
            return data
        except httpx.HTTPError as e:
            logger.error("Exchange request failed", error=str(e))
            raise

    def _sign_payload(self, payload: dict) -> dict:
        """Sign a payload using the agent's private key.
        
        Uses EIP-712 signing for Hyperliquid exchange actions.
        The trading-only key ensures this signature can only authorize trades.
        """
        # Import here to avoid hard dependency if not needed
        from eth_account import Account
        from eth_account.messages import encode_defunct
        import json
        
        # Create the message to sign
        # Hyperliquid uses a specific domain for exchange actions
        domain = {
            "name": "Hyperliquid Exchange",
            "version": "1",
            "chainId": 1337 if self.testnet else 421614,
            "verifyingContract": "0x0000000000000000000000000000000000000000",
        }
        
        message = {
            "domain": domain,
            "types": {
                "Action": [
                    {"name": "action", "type": "string"},
                    {"name": "nonce", "type": "string"},
                ],
            },
            "value": {
                "action": json.dumps(payload["action"], separators=(",", ":")),
                "nonce": payload["nonce"],
            },
        }
        
        # Sign with the private key
        account = Account.from_key(self.secret_key)
        msg_hash = encode_defunct(message)
        signed = account.sign_message(msg_hash)
        
        return {
            "r": "0x" + signed.r.to_bytes(32, "big").hex(),
            "s": "0x" + signed.s.to_bytes(32, "big").hex(),
            "v": signed.v + 27,
        }


# Utility functions
async def get_asset_info(meta: dict, coin: str) -> Optional[dict]:
    """Get asset info from meta response."""
    for asset in meta.get("universe", []):
        if asset["name"] == coin:
            return asset
    return None


def size_to_precision(size: float, decimals: int) -> str:
    """Convert size to string with proper precision."""
    factor = 10 ** decimals
    return str(int(size * factor) / factor)


def price_to_precision(price: float, tick_size: float) -> str:
    """Convert price to string with proper tick size."""
    precision = len(str(tick_size).split(".")[-1]) if "." in str(tick_size) else 0
    return f"{price:.{precision}f}"


def generate_cloid() -> str:
    """Generate a client order ID (128-bit hex)."""
    import secrets
    return "0x" + secrets.token_hex(16)