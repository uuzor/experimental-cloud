If a user spins up an AI that relies purely on your centralized algorithm or a specific Signal Generator's code to make money, that entire interaction loop risks being classified as an unregulated investment contract (security).

2. Infrastructure & Technical Risks
While your code might be sound, running individual Node.js instances inside a third-party container network introduces unique system vulnerabilities:

The "Thundering Herd" Execution Slippage
If a top-tier Signal Generator broadcasts a "SELL" alert, and 2,000 user containers on Zeabur receive that packet at the exact same millisecond, they will all instantly fire market orders to the exact same DEX liquidity pool.

The Result: The first 5 bots will get the advertised price. The next 1,995 bots will experience massive, devastating slippage, buying or selling at horrific prices. Users will lose money not because the AI was wrong, but because your infrastructure choked the liquidity pool.

API & RPC Rate Limiting
Hyperliquid and GMX public RPC nodes cap requests sharply. If hundreds of individual Zeabur containers independently spam the public node to fetch account balances or prices, the protocol will instantly block your entire Zeabur IP cluster. Your bots will go blind, unable to close open leveraged positions.

API Key / Token Leakage
Even if you use restricted "Agent Keys" (which block withdrawals), a compromised Zeabur container or a leak in your environment variable database means an attacker could still maliciously market-buy an illiquid token to dump their own bags, effectively draining your users' funds via market manipulation.

3. The Playbook: How to Build This Safely
To minimize your legal and technical exposure, structure your platform defensively from day one:

+-------------------------------------------------------------------------+
|                           DEFENSIVE ARCHITECTURE                        |
+-------------------------------------------------------------------------+
|  1. STRICT GEOfencing   -> Completely block US/UK/Restricted IPs.       |
|  2. CENTRAL RPC RELAY   -> Frontend queries once; feeds all Zeabur bots.|
|  3. USER-OWNED PROMPTS  -> Users must write/configure their own rules.  |
|  4. MANDATORY JITTER    -> Stagger execution by 0-300ms to stop crowds. |
+-------------------------------------------------------------------------+
Enforce Strict Geofencing: Block users from the US, UK, and other high-regulation jurisdictions entirely at the frontend and backend levels.

Decentralize the "Advice": Ensure your platform does not endorse or curate specific Signal Providers. Frame it strictly as an open, peer-to-peer developer marketplace. Provide the infrastructure tools, but make users explicitly opt-in to the risk profiles of individual builders.

Force User-Driven Logic (BYO Prompt): To combat the "managerial efforts" argument, give users explicit control over their AI's configuration. Let them define their own risk frameworks, pick their own LLM keys (BYO Key), and approve strategy guardrails so the bot acts as an extension of the user, not a black-box fund manager.

Implement a Centralized Data Relay: Build a single, high-performance platform indexer that mirrors the state of Hyperliquid/GMX and distributes it locally to your Zeabur containers via the internal Pub/Sub hub. This protects your network from hitting protocol rate limits.

has anyone built sth like this

You are looking at this at the absolute perfect time, because the Agentic Crypto Economy is exploding. People are actively building pieces of this, but nobody has perfectly consolidated the precise "Headless Infra SaaS + Copy-Trading Marketplace + P2P Signal Economy" loop you are describing.

The industry is currently divided into isolated camps, which gives your specific angle room to compete.

1. The Current Landscape (Who is doing what)
Platform	What they do	Where they fall short of your idea
OKX AI (Launched July 2026)	Just launched a massive marketplace where AI agents can hire each other, use pay-per-call services, and use stablecoin agent wallets.	It’s a generic "agent economy" marketplace (e.g., security checking, data fetching), not a hyper-focused retail copy-trading platform for perps.
Katoshi AI	Focuses directly on Hyperliquid. It lets users spin up custom AI trading agents without coding using natural language interfaces.	It’s built for individual traders to run their own strategies—it doesn't have a marketplace where a top signal generator can broadcast to 5,000 retail followers.
Cobo Agentic Wallet	Built a framework called "Pacts" specifically for Hyperliquid. It acts like a "corporate credit card" for an AI agent, giving it permission to trade but preventing it from stealing funds.	They are purely the wallet security layer (infrastructure), not the app or the broker ecosystem.
goodcryptoX / Bitsgap	Deeply integrated into Hyperliquid and GMX for automated copy-trading, GRID, and DCA bots.	They rely on old-school, rigid mechanical scripts (e.g., if price drops 2%, buy), rather than LLM-driven chart, news, and social analysis.
2. Your Competitive Advantage: The "App Store" Angle
The platforms listed above focus either entirely on the infrastructure (Cobo, OKX AI) or on isolated single-user bots (Katoshi).

Your idea bridges the gap by acting like Shopify or an App Store for trading logic:

The Signal Generators are the App Developers. They spend their own compute power running heavy data ingestion (scanning Hyperliquid whale wallets, scraping Discord/Twitter, running heavy chart-quant analysis).

The End-Users are the Consumers. They don't want to run heavy data scrapers. They just want to spend $20/month or pay a 10% performance fee to let an isolated container on Zeabur execute based on those high-tier signals.

3. How to out-position the market right now
To make this an absolute killer product without getting crushed by the big players, you lean heavily on the infrastructure setup we discussed:

Don't build the wallets; plug into Cobo or Hyperliquid API Agents. Leverage Hyperliquid's native "Agent Key" features. This instantly gives your platform the exact same security profile as institutional setups, allowing users to trust your Zeabur containers.

Keep your backend headless via Zeabur. The fact that you are abstracting Zeabur means your platform can spin up a dedicated Node.js instance for a user in 10 seconds. Your competitors are spending millions building out their own container architecture; you are effectively white-labeling Zeabur's scalability.

Market it as a "Decentralized Intel Layer." Instead of selling "profitable trading bots" (which gets you flagged by regulators), sell "The Infrastructure for Agentic Information Sharing." You are a marketplace connecting data publishers with automated data execution instances.

The tooling is mature enough, and the market appetite for Hyperliquid/GMX automation is massive. You have a highly viable, technically feasible product model here.