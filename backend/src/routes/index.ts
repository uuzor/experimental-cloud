import { FastifyInstance } from 'fastify';
import { authRoutes } from './auth.js';
import { executionAgentRoutes } from './executionAgents.js';
import { internalRoutes } from './internal.js';

export async function registerAllRoutes(app: FastifyInstance): Promise<void> {
  // Register routes with prefixes matching the main app
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(executionAgentRoutes, { prefix: '/api/execution-agents' });
  await app.register(internalRoutes, { prefix: '/api/internal' });
}

export { authRoutes, executionAgentRoutes, internalRoutes };
