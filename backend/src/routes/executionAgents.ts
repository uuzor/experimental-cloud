import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/index.js';
import { logger } from '../db/logger.js';
import { logAuditEvent } from '../services/audit.js';
import { zeaburManager } from '../services/zeabur.js';
import { z } from 'zod';

const agentLogger = logger.child({ module: 'execution-agents' });

const createAgentSchema = z.object({
  max_position_usd: z.number().positive(),
  max_leverage: z.number().min(1).max(20).optional().default(3),
  daily_loss_limit_usd: z.number().nonnegative().nullable().optional(),
  llm_filter_enabled: z.boolean().optional().default(false),
});

const updateAgentConfigSchema = z.object({
  max_position_usd: z.number().positive().optional(),
  max_leverage: z.number().min(1).max(20).optional(),
  daily_loss_limit_usd: z.number().nonnegative().nullable().optional(),
  llm_filter_enabled: z.boolean().optional(),
});

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: {
      id: string;
      email: string;
    };
  }
}

export async function executionAgentRoutes(fastify: FastifyInstance) {
  
  // Create execution agent - Deploys to Zeabur
  fastify.post(
    '/',
    { onRequest: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = createAgentSchema.safeParse(request.body);

      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Invalid request',
          details: parseResult.error.errors,
        });
      }

      const user = request.user as { id: string; email: string };
      const { max_position_usd, max_leverage, daily_loss_limit_usd, llm_filter_enabled } =
        parseResult.data;

      try {
        // Check if user already has an agent
        const existingAgent = await pool.query(
          'SELECT id FROM execution_agents WHERE user_id = $1 AND status != $2',
          [user.id, 'terminated']
        );

        if (existingAgent.rows.length > 0) {
          return reply.status(409).send({
            error: 'User already has an active execution agent',
          });
        }

        // Generate agent token for authentication
        const agentToken = crypto.randomUUID();
        
        // Create execution agent in DB
        const result = await pool.query(
          `INSERT INTO execution_agents
           (user_id, wallet_id, max_position_usd, max_leverage, daily_loss_limit_usd, llm_filter_enabled, agent_control_token_hash, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'provisioning')
           RETURNING *`,
          [user.id, wallet_id, max_position_usd, max_leverage, daily_loss_limit_usd, llm_filter_enabled, agentToken]
        );

        const agent = result.rows[0];

        // Deploy to Zeabur
        const zeaburService = await zeaburManager.deployExecutionAgent(
          agent.id,
          agentToken,
          {
            maxPositionUsd: max_position_usd,
            maxLeverage: max_leverage,
            allowedSymbols: ['BTC', 'ETH'], // Default
          }
        );

        if (zeaburService) {
          // Update agent with Zeabur service info
          await pool.query(
            `UPDATE execution_agents 
             SET zeabur_service_id = $1, agent_internal_url = $2, status = 'active'
             WHERE id = $3`,
            [zeaburService.id, zeaburService.url, agent.id]
          );
          
          agent.zeabur_service_id = zeaburService.id;
          agent.agent_internal_url = zeaburService.url;
          agent.status = 'active';
        } else {
          // Failed to provision, mark as failed
          await pool.query(
            `UPDATE execution_agents SET status = 'failed' WHERE id = $1`,
            [agent.id]
          );
          agent.status = 'failed';
        }

        await logAuditEvent({
          actor: user.id,
          action: 'execution_agent.create',
          target_type: 'execution_agent',
          target_id: agent.id,
          detail: { max_position_usd, max_leverage, zeaburServiceId: zeaburService?.id },
        });

        agentLogger.info({ userId: user.id, agentId: agent.id }, 'Execution agent created');

        return reply.status(201).send({ 
          agent: {
            id: agent.id,
            status: agent.status,
            internalUrl: agent.agent_internal_url || zeaburService?.url,
            zeaburServiceId: agent.zeabur_service_id || zeaburService?.id,
            config: {
              maxPositionUsd: agent.max_position_usd,
              maxLeverage: agent.max_leverage,
              llmFilterEnabled: agent.llm_filter_enabled,
            },
          },
          agentToken, // Only returned on creation
        });
      } catch (err) {
        agentLogger.error({ err }, 'Failed to create execution agent');
        return reply.status(500).send({ error: 'Internal server error', details: String(err) });
      }
    }
  );

  // Get execution agent for current user
  fastify.get(
    '/',
    { onRequest: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user as { id: string };

      try {
        const result = await pool.query(
          `SELECT * FROM execution_agents WHERE user_id = $1 AND status != 'terminated'`,
          [user.id]
        );

        if (result.rows.length === 0) {
          return reply.status(404).send({ error: 'No execution agent found' });
        }

        const agent = result.rows[0];
        return reply.send({ 
          agent: {
            id: agent.id,
            status: agent.status,
            internalUrl: agent.internal_url,
            zeaburServiceId: agent.zeabur_service_id,
            config: {
              maxPositionUsd: agent.max_position_usd,
              maxLeverage: agent.max_leverage,
              dailyLossLimitUsd: agent.daily_loss_limit_usd,
              llmFilterEnabled: agent.llm_filter_enabled,
            },
            lastHeartbeat: agent.last_heartbeat,
            createdAt: agent.created_at,
          },
        });
      } catch (err) {
        agentLogger.error({ err }, 'Failed to get execution agent');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Get execution agent by ID
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const user = request.user as { id: string };
      const { id } = request.params;

      try {
        const result = await pool.query(
          `SELECT * FROM execution_agents WHERE id = $1`,
          [id]
        );

        if (result.rows.length === 0) {
          return reply.status(404).send({ error: 'Execution agent not found' });
        }

        const agent = result.rows[0];

        if (agent.user_id !== user.id) {
          return reply.status(403).send({ error: 'Access denied' });
        }

        return reply.send({ agent });
      } catch (err) {
        agentLogger.error({ err }, 'Failed to get execution agent');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Update execution agent config
  fastify.patch<{ Params: { id: string } }>(
    '/:id/config',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const user = request.user as { id: string };
      const { id } = request.params;

      const parseResult = updateAgentConfigSchema.safeParse(request.body);

      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Invalid request',
          details: parseResult.error.errors,
        });
      }

      try {
        const currentResult = await pool.query(
          `SELECT * FROM execution_agents WHERE id = $1`,
          [id]
        );

        if (currentResult.rows.length === 0) {
          return reply.status(404).send({ error: 'Execution agent not found' });
        }

        const currentAgent = currentResult.rows[0];

        if (currentAgent.user_id !== user.id) {
          return reply.status(403).send({ error: 'Access denied' });
        }

        // Build update query
        const updates: string[] = [];
        const values: unknown[] = [];
        let paramIndex = 1;

        if (parseResult.data.max_position_usd !== undefined) {
          updates.push(`max_position_usd = $${paramIndex++}`);
          values.push(parseResult.data.max_position_usd);
        }
        if (parseResult.data.max_leverage !== undefined) {
          updates.push(`max_leverage = $${paramIndex++}`);
          values.push(parseResult.data.max_leverage);
        }
        if (parseResult.data.daily_loss_limit_usd !== undefined) {
          updates.push(`daily_loss_limit_usd = $${paramIndex++}`);
          values.push(parseResult.data.daily_loss_limit_usd);
        }
        if (parseResult.data.llm_filter_enabled !== undefined) {
          updates.push(`llm_filter_enabled = $${paramIndex++}`);
          values.push(parseResult.data.llm_filter_enabled);
        }

        if (updates.length === 0) {
          return reply.status(400).send({ error: 'No fields to update' });
        }

        values.push(id);

        const result = await pool.query(
          `UPDATE execution_agents SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
          values
        );

        // Update Zeabur service env if needed
        if (currentAgent.zeabur_service_id && parseResult.data.max_position_usd) {
          await zeaburManager.updateServiceEnv(
            currentAgent.zeabur_service_id,
            { 'MAX_POSITION_USD': parseResult.data.max_position_usd.toString() }
          );
        }

        await logAuditEvent({
          actor: user.id,
          action: 'execution_agent.config_update',
          target_type: 'execution_agent',
          target_id: id,
          detail: parseResult.data,
        });

        agentLogger.info({ userId: user.id, agentId: id }, 'Execution agent config updated');

        return reply.send({ agent: result.rows[0] });
      } catch (err) {
        agentLogger.error({ err }, 'Failed to update execution agent config');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Suspend execution agent
  fastify.post<{ Params: { id: string } }>(
    '/:id/suspend',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const user = request.user as { id: string };
      const { id } = request.params;

      try {
        const currentResult = await pool.query(
          `SELECT * FROM execution_agents WHERE id = $1`,
          [id]
        );

        if (currentResult.rows.length === 0) {
          return reply.status(404).send({ error: 'Execution agent not found' });
        }

        const currentAgent = currentResult.rows[0];

        if (currentAgent.user_id !== user.id) {
          return reply.status(403).send({ error: 'Access denied' });
        }

        // Restart Zeabur service to trigger pause
        if (currentAgent.zeabur_service_id) {
          await zeaburManager.restartService(currentAgent.zeabur_service_id);
        }

        const result = await pool.query(
          `UPDATE execution_agents SET status = 'suspended' WHERE id = $1 RETURNING *`,
          [id]
        );

        await logAuditEvent({
          actor: user.id,
          action: 'execution_agent.suspend',
          target_type: 'execution_agent',
          target_id: id,
        });

        agentLogger.info({ userId: user.id, agentId: id }, 'Execution agent suspended');

        return reply.send({ agent: result.rows[0] });
      } catch (err) {
        agentLogger.error({ err }, 'Failed to suspend execution agent');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Resume execution agent
  fastify.post<{ Params: { id: string } }>(
    '/:id/resume',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const user = request.user as { id: string };
      const { id } = request.params;

      try {
        const currentResult = await pool.query(
          `SELECT * FROM execution_agents WHERE id = $1`,
          [id]
        );

        if (currentResult.rows.length === 0) {
          return reply.status(404).send({ error: 'Execution agent not found' });
        }

        const currentAgent = currentResult.rows[0];

        if (currentAgent.user_id !== user.id) {
          return reply.status(403).send({ error: 'Access denied' });
        }

        if (currentAgent.status !== 'suspended') {
          return reply.status(400).send({ error: 'Agent is not suspended' });
        }

        // Restart Zeabur service to resume
        if (currentAgent.zeabur_service_id) {
          await zeaburManager.restartService(currentAgent.zeabur_service_id);
        }

        const result = await pool.query(
          `UPDATE execution_agents SET status = 'active' WHERE id = $1 RETURNING *`,
          [id]
        );

        await logAuditEvent({
          actor: user.id,
          action: 'execution_agent.resume',
          target_type: 'execution_agent',
          target_id: id,
        });

        agentLogger.info({ userId: user.id, agentId: id }, 'Execution agent resumed');

        return reply.send({ agent: result.rows[0] });
      } catch (err) {
        agentLogger.error({ err }, 'Failed to resume execution agent');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Delete (terminate) execution agent
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const user = request.user as { id: string };
      const { id } = request.params;

      try {
        const currentResult = await pool.query(
          `SELECT * FROM execution_agents WHERE id = $1`,
          [id]
        );

        if (currentResult.rows.length === 0) {
          return reply.status(404).send({ error: 'Execution agent not found' });
        }

        const currentAgent = currentResult.rows[0];

        if (currentAgent.user_id !== user.id) {
          return reply.status(403).send({ error: 'Access denied' });
        }

        // Delete Zeabur service
        if (currentAgent.zeabur_service_id) {
          await zeaburManager.deleteService(currentAgent.zeabur_service_id);
        }

        await pool.query(
          `UPDATE execution_agents SET status = 'terminated' WHERE id = $1`,
          [id]
        );

        await logAuditEvent({
          actor: user.id,
          action: 'execution_agent.terminate',
          target_type: 'execution_agent',
          target_id: id,
        });

        agentLogger.info({ userId: user.id, agentId: id }, 'Execution agent terminated');

        return reply.status(204).send();
      } catch (err) {
        agentLogger.error({ err }, 'Failed to terminate execution agent');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );
}
