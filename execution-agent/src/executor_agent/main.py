"""Main entry point for the execution agent."""

import asyncio
import signal
import os
import structlog

from dotenv import load_dotenv

# Load environment variables
load_dotenv()

from ..executor.agent import ExecutionAgent


async def main() -> None:
    """Main entry point."""
    # Configure logging
    structlog.configure(
        wrapper_class=structlog.make_filtering_bound_logger(
            int(os.getenv("LOG_LEVEL", "20"))  # INFO = 20
        ),
    )
    
    logger = structlog.get_logger(__name__)
    logger.info("Starting Execution Agent...")
    
    agent = ExecutionAgent()
    
    # Handle shutdown signals
    loop = asyncio.get_event_loop()
    
    def shutdown():
        logger.info("Shutdown signal received")
        asyncio.create_task(agent.stop())
        for task in asyncio.all_tasks(loop):
            task.cancel()
    
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, shutdown)
        except NotImplementedError:
            # Windows doesn't support add_signal_handler
            pass
    
    try:
        await agent.start()
        
        # Keep running
        while agent._running:
            await asyncio.sleep(1)
            
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.error("Fatal error", error=str(e))
        raise
    finally:
        await agent.stop()
        logger.info("Execution Agent stopped")


if __name__ == "__main__":
    asyncio.run(main())