import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { logger } from './db/logger.js';
import { pool } from './db/index.js';
import { authRoutes } from './routes/auth.js';
import { executionAgentRoutes } from './routes/executionAgents.js';
import { internalRoutes } from './routes/internal.js';

const fastify = Fastify({
  logger: logger,
});

// Register plugins
await fastify.register(cors, {
  origin: true,
  credentials: true,
});

await fastify.register(jwt, {
  secret: process.env.JWT_SECRET || 'fallback-secret-change-in-production',
});

// Auth decorator
fastify.decorate('authenticate', async function (request: any, reply: any) {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.status(401).send({ error: 'Unauthorized' });
  }
});

// Health check
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Register routes
fastify.register(authRoutes, { prefix: '/v1/auth' });
fastify.register(executionAgentRoutes, { prefix: '/v1/execution-agents' });
fastify.register(internalRoutes, { prefix: '/v1' });

// Graceful shutdown
const shutdown = async () => {
  logger.info('Shutting down...');
  await fastify.close();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
const start = async () => {
  try {
    // Test database connection
    await pool.query('SELECT 1');
    logger.info('Database connection established');

    const port = parseInt(process.env.PORT || '3000', 10);
    const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '0.0.0.0';

    await fastify.listen({ port, host });
    logger.info(`Server listening on ${host}:${port}`);
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
};

start();
