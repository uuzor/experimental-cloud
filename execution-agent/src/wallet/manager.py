"""Agent wallet management for Hyperliquid.

This module handles:
1. Creating new trading-only agent wallets
2. Tracking wallet state (equity, positions, margin)
3. Ensuring wallets are properly funded with USDC
"""

import time
from typing import Optional
from dataclasses import dataclass
from eth_account import Account
import structlog

from ..hyperliquid.client import HyperliquidClient

logger = structlog.get_logger(__name__)


@dataclass
class AgentWallet:
    """Represents a trading agent wallet."""
    address: str
    private_key: str  # Trading-only key (NOT withdrawal key)
    label: str  # e.g., "agent-123"
    created_at: int
    is_active: bool = True


class WalletManager:
    """Manages agent wallets on Hyperliquid."""

    def __init__(
        self,
        backend_url: str,
        api_key: str,
    ):
        """Initialize wallet manager.
        
        Args:
            backend_url: URL of the backend API
            api_key: Platform API key for backend auth
        """
        self.backend_url = backend_url.rstrip("/")
        self.api_key = api_key
        self._wallets: dict[str, AgentWallet] = {}
        self._clients: dict[str, HyperliquidClient] = {}

    def create_wallet(self, label: str) -> AgentWallet:
        """Create a new trading-only agent wallet.
        
        The private key generated here is structurally restricted to trading.
        It cannot authorize withdrawals - only exchange operations.
        """
        # Generate new key pair
        account = Account.create()
        
        wallet = AgentWallet(
            address=account.address,
            private_key="0x" + account.key.hex(),  # Add 0x prefix
            label=label,
            created_at=int(time.time() * 1000),
        )
        
        self._wallets[wallet.address.lower()] = wallet  # Store lowercase for case-insensitive lookup
        logger.info(
            "Created agent wallet",
            address=wallet.address,
            label=label,
        )
        
        return wallet

    def get_client(self, wallet: AgentWallet) -> HyperliquidClient:
        """Get or create a Hyperliquid client for a wallet."""
        if wallet.address not in self._clients:
            self._clients[wallet.address] = HyperliquidClient(
                account_address=wallet.address,
                secret_key=wallet.private_key,
            )
        return self._clients[wallet.address]

    async def get_wallet_state(self, wallet: AgentWallet) -> Optional[dict]:
        """Get current state of a wallet from Hyperliquid."""
        client = self.get_client(wallet)
        try:
            state = await client.get_user_state(wallet.address)
            return state
        except Exception as e:
            logger.error("Failed to get wallet state", address=wallet.address, error=str(e))
            return None

    async def fund_wallet(
        self,
        wallet: AgentWallet,
        amount_usdc: float,
    ) -> dict:
        """Request funds from the main wallet for an agent.
        
        This calls the backend to transfer USDC from the platform's
        main wallet to the agent wallet.
        """
        import httpx
        
        async with httpx.AsyncClient() as client:
            try:
                response = await client.post(
                    f"{self.backend_url}/api/internal/wallet/fund",
                    json={
                        "agent_address": wallet.address,
                        "amount": amount_usdc,
                    },
                    headers={
                        "Content-Type": "application/json",
                        "X-API-Key": self.api_key,
                    },
                    timeout=30.0,
                )
                response.raise_for_status()
                result = response.json()
                
                logger.info(
                    "Wallet funded",
                    address=wallet.address,
                    amount=amount_usdc,
                    tx_hash=result.get("tx_hash"),
                )
                return result
            except httpx.HTTPError as e:
                logger.error(
                    "Failed to fund wallet",
                    address=wallet.address,
                    error=str(e),
                )
                raise

    async def register_with_backend(
        self,
        wallet: AgentWallet,
        user_id: str,
    ) -> dict:
        """Register an agent wallet with the backend."""
        import httpx
        
        async with httpx.AsyncClient() as client:
            try:
                response = await client.post(
                    f"{self.backend_url}/api/internal/agents",
                    json={
                        "address": wallet.address,
                        "label": wallet.label,
                        "user_id": user_id,
                        "public_key": wallet.private_key[:66],  # Only public part
                    },
                    headers={
                        "Content-Type": "application/json",
                        "X-API-Key": self.api_key,
                    },
                    timeout=30.0,
                )
                response.raise_for_status()
                result = response.json()
                
                logger.info(
                    "Agent registered with backend",
                    address=wallet.address,
                    agent_id=result.get("id"),
                )
                return result
            except httpx.HTTPError as e:
                logger.error(
                    "Failed to register agent",
                    address=wallet.address,
                    error=str(e),
                )
                raise

    def get_all_wallets(self) -> list[AgentWallet]:
        """Get all managed wallets."""
        return list(self._wallets.values())

    def get_wallet_by_address(self, address: str) -> Optional[AgentWallet]:
        """Get a wallet by address."""
        return self._wallets.get(address.lower())

    async def close_all(self):
        """Close all Hyperliquid clients."""
        for client in self._clients.values():
            await client.close()
        self._clients.clear()


async def create_agent_for_user(
    backend_url: str,
    api_key: str,
    user_id: str,
    label: Optional[str] = None,
) -> tuple[AgentWallet, dict]:
    """Convenience function to create a fully provisioned agent wallet.
    
    Creates the wallet, registers it with the backend, and returns
    both the wallet and the backend registration response.
    """
    manager = WalletManager(backend_url, api_key)
    
    wallet_label = label or f"agent-{user_id[:8]}"
    wallet = manager.create_wallet(wallet_label)
    
    # Register with backend
    backend_response = await manager.register_with_backend(wallet, user_id)
    
    return wallet, backend_response