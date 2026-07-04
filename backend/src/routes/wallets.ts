/**
 * Hyperliquid Agent Wallet Registration
 * 
 * Users register their pre-created agent wallet address.
 * We never store the private key - only the address.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/index.js';
import { logger } from '../db/logger.js';
import { logAuditEvent } from '../services/audit.js';
import { z } from 'zod';

const walletLogger = logger.child({ module: 'wallets' });

const registerWalletSchema = z.object({
  agent_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  agent_name: z.string().min(1).max(100),
});

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export async function walletRoutes(fastify: FastifyInstance) {

  // Register a Hyperliquid agent wallet
  fastify.post(
    '/',
    { onRequest: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = registerWalletSchema.safeParse(request.body);

      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Invalid request',
          details: parseResult.error.errors,
        });
      }

      const user = request.user as { id: string };
      const { agent_address, agent_name } = parseResult.data;

      try {
        // Check if user already has a registered wallet
        const existing = await pool.query(
          'SELECT id FROM hl_agent_wallets WHERE user_id = $1 AND status = $2',
          [user.id, 'active']
        );

        if (existing.rows.length > 0) {
          return reply.status(409).send({
            error: 'User already has an active agent wallet',
          });
        }

        // Register the wallet
        // Note: encrypted_agent_key and master_address may not exist in all schemas
        const result = await pool.query(
          `INSERT INTO hl_agent_wallets
           (user_id, agent_address, agent_name, status, registered_at)
           VALUES ($1, $2, $3, 'active', NOW())
           RETURNING *`,
          [user.id, agent_address.toLowerCase(), agent_name]
        );

        const wallet = result.rows[0];

        await logAuditEvent({
          actor: user.id,
          action: 'wallet.register',
          target_type: 'hl_agent_wallet',
          target_id: wallet.id,
          detail: { agent_address, agent_name },
        });

        walletLogger.info({ userId: user.id, walletId: wallet.id }, 'Agent wallet registered');

        return reply.status(201).send({
          wallet: {
            id: wallet.id,
            agentAddress: wallet.agent_address,
            agentName: wallet.agent_name,
            status: wallet.status,
            registeredAt: wallet.registered_at,
          },
        });
      } catch (err) {
        walletLogger.error({ err }, 'Failed to register wallet');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Get user's registered wallet
  fastify.get(
    '/',
    { onRequest: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user as { id: string };

      try {
        const result = await pool.query(
          `SELECT * FROM hl_agent_wallets WHERE user_id = $1 AND status = 'active'`,
          [user.id]
        );

        if (result.rows.length === 0) {
          return reply.status(404).send({ error: 'No agent wallet found' });
        }

        const wallet = result.rows[0];
        return reply.send({
          wallet: {
            id: wallet.id,
            agentAddress: wallet.agent_address,
            agentName: wallet.agent_name,
            status: wallet.status,
            registeredAt: wallet.registered_at,
          },
        });
      } catch (err) {
        walletLogger.error({ err }, 'Failed to get wallet');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Delete/revoke wallet
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const user = request.user as { id: string };
      const { id } = request.params;

      try {
        const current = await pool.query(
          `SELECT * FROM hl_agent_wallets WHERE id = $1`,
          [id]
        );

        if (current.rows.length === 0) {
          return reply.status(404).send({ error: 'Wallet not found' });
        }

        const wallet = current.rows[0];

        if (wallet.user_id !== user.id) {
          return reply.status(403).send({ error: 'Access denied' });
        }

        await pool.query(
          `UPDATE hl_agent_wallets SET status = 'revoked' WHERE id = $1`,
          [id]
        );

        await logAuditEvent({
          actor: user.id,
          action: 'wallet.revoke',
          target_type: 'hl_agent_wallet',
          target_id: id,
        });

        walletLogger.info({ userId: user.id, walletId: id }, 'Agent wallet revoked');

        return reply.status(204).send();
      } catch (err) {
        walletLogger.error({ err }, 'Failed to revoke wallet');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );
}
