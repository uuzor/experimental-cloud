import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { pool } from '../db/index.js';
import { logger } from '../db/logger.js';
import { z } from 'zod';

const internalLogger = logger.child({ module: 'internal' });

// Verify PLATFORM_API_KEY for internal routes
async function verifyPlatformKey(request: FastifyRequest, reply: FastifyReply) {
  const apiKey = request.headers['x-platform-key'];

  if (!apiKey || apiKey !== process.env.PLATFORM_API_KEY) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
}

// Agent handshake schema
const agentHandshakeSchema = z.object({
  agent_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

// Generate a short-lived Redis token for the agent
function generateStreamToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// Agent handshake - called by execution agent at boot
async function handleAgentHandshake(fastify: FastifyInstance) {
  fastify.post(
    '/agents/handshake',
    { onRequest: [verifyPlatformKey] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = agentHandshakeSchema.safeParse(request.body);

      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Invalid request',
          details: parseResult.error.errors,
        });
      }

      const { agent_id, user_id } = parseResult.data;

      try {
        // Get agent and verify user
        const result = await pool.query(
          `SELECT ea.*, u.subscription_status
           FROM execution_agents ea
           JOIN users u ON ea.user_id = u.id
           WHERE ea.id = $1 AND ea.user_id = $2`,
          [agent_id, user_id]
        );

        if (result.rows.length === 0) {
          return reply.status(404).send({ error: 'Agent not found' });
        }

        const agent = result.rows[0];

        // Check subscription status
        if (agent.subscription_status !== 'active') {
          return reply.status(403).send({
            error: 'Subscription not active',
            subscription_status: agent.subscription_status,
          });
        }

        // Generate stream token
        const streamToken = generateStreamToken();
        const streamTokenHash = crypto.createHash('sha256').update(streamToken).digest('hex');

        // Generate agent control token if not exists
        let agentControlToken = agent.agent_control_token_hash;
        if (!agentControlToken) {
          agentControlToken = crypto.randomBytes(32).toString('hex');
          const agentControlTokenHash = crypto.createHash('sha256').update(agentControlToken).digest('hex');

          await pool.query(
            `UPDATE execution_agents SET agent_control_token_hash = $1 WHERE id = $2`,
            [agentControlTokenHash, agent_id]
          );
        }

        // Update agent status and heartbeat
        await pool.query(
          `UPDATE execution_agents
           SET status = 'active', last_heartbeat_at = NOW()
           WHERE id = $1`,
          [agent_id]
        );

        internalLogger.info({ agentId: agent_id, userId: user_id }, 'Agent handshake successful');

        return reply.send({
          redis_stream_token: streamToken,
          redis_stream_url: process.env.REDIS_URL || 'redis://localhost:6379',
          redis_stream_channel: 'signals:v1',
          config: {
            max_position_usd: agent.max_position_usd,
            max_leverage: agent.max_leverage,
            daily_loss_limit_usd: agent.daily_loss_limit_usd,
            llm_filter_enabled: agent.llm_filter_enabled,
          },
          agent_control_token: agentControlToken,
        });
      } catch (err) {
        internalLogger.error({ err }, 'Agent handshake failed');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );
}

// Telemetry ingestion - called by execution agents
async function handleTelemetry(fastify: FastifyInstance) {
  const telemetrySchema = z.object({
    agent_id: z.string().uuid(),
    type: z.enum(['heartbeat', 'execution', 'error']),
    data: z.record(z.unknown()),
  });

  fastify.post(
    '/telemetry',
    { onRequest: [verifyPlatformKey] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = telemetrySchema.safeParse(request.body);

      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Invalid telemetry data',
          details: parseResult.error.errors,
        });
      }

      const { agent_id, type, data } = parseResult.data;

      try {
        // Verify agent exists
        const agentResult = await pool.query(
          `SELECT id FROM execution_agents WHERE id = $1`,
          [agent_id]
        );

        if (agentResult.rows.length === 0) {
          return reply.status(404).send({ error: 'Agent not found' });
        }

        // Update heartbeat
        if (type === 'heartbeat') {
          const status = (data.status as string) || 'ok';

          await pool.query(
            `UPDATE execution_agents SET last_heartbeat_at = NOW() WHERE id = $1`,
            [agent_id]
          );

          await pool.query(
            `INSERT INTO agent_heartbeats (execution_agent_id, status)
             VALUES ($1, $2)`,
            [agent_id, status]
          );

          // If status is not 'ok', log it
          if (status !== 'ok') {
            internalLogger.warn({ agentId: agent_id, status }, 'Agent reported degraded status');
          }
        }

        // Handle execution telemetry
        if (type === 'execution' && data.execution) {
          const exec = data.execution as Record<string, unknown>;

          await pool.query(
            `INSERT INTO executions
             (execution_agent_id, signal_id, hl_order_id, asset, side, size,
              filled_at, fill_price, status, error_detail, jitter_ms_applied)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              agent_id,
              exec.signal_id || null,
              exec.hl_order_id || null,
              exec.asset,
              exec.side,
              exec.size,
              exec.filled_at || null,
              exec.fill_price || null,
              exec.status || 'pending',
              exec.error_detail || null,
              exec.jitter_ms_applied || null,
            ]
          );
        }

        // Handle error telemetry
        if (type === 'error' && data.error) {
          internalLogger.error(
            { agentId: agent_id, error: data.error },
            'Agent reported error'
          );

          // Log to audit for significant errors
          await pool.query(
            `INSERT INTO audit_log (actor, action, target_type, target_id, detail)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              agent_id,
              'agent.error',
              'execution_agent',
              agent_id,
              JSON.stringify(data.error),
            ]
          );
        }

        return reply.status(204).send();
      } catch (err) {
        internalLogger.error({ err }, 'Failed to process telemetry');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );
}

// Signal tracker heartbeat
async function handleSignalTrackerHeartbeat(fastify: FastifyInstance) {
  fastify.post(
    '/signal-tracker/heartbeat',
    { onRequest: [verifyPlatformKey] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      internalLogger.debug('Signal tracker heartbeat received');
      return reply.status(204).send();
    }
  );
}

// Get stream token for agent (used by backend to issue Redis access)
async function handleGetStreamToken(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string } }>(
    '/agents/:id/stream-token',
    { onRequest: [verifyPlatformKey] },
    async (request, reply) => {
      const { id } = request.params;

      try {
        const token = generateStreamToken();

        // In production, you'd store this token with expiry in Redis
        // For now, return it directly - the agent will use it to authenticate

        return reply.send({ token });
      } catch (err) {
        internalLogger.error({ err }, 'Failed to generate stream token');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );
}

export async function internalRoutes(fastify: FastifyInstance) {
  await handleAgentHandshake(fastify);
  await handleTelemetry(fastify);
  await handleSignalTrackerHeartbeat(fastify);
  await handleGetStreamToken(fastify);
}
