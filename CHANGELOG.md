# Changelog

## [1.0.0] - 2026-07-04

### Added

#### Backend (TypeScript/Fastify)
- User authentication (JWT-based register/login)
- Hyperliquid agent wallet registration API
- Execution agent CRUD with Zeabur provisioning
- Agent handshake endpoint for boot-time authentication
- Telemetry ingestion endpoint
- Redis stream token generation
- PostgreSQL database schema
- Audit logging

#### Signal Tracker (TypeScript/Node.js)
- Hyperliquid Info API integration
- WebSocket real-time position monitoring
- Top trader wallet tracking
- Position change signal generation
- Redis Streams publisher

#### Execution Agent (Python)
- Signal consumer from Redis Streams
- Risk management and circuit breaker
- Jitter for thundering herd prevention
- Hyperliquid order execution
- Telemetry reporting

#### Infrastructure
- Docker support for all services
- GitHub Actions CI/CD
- Zeabur deployment integration