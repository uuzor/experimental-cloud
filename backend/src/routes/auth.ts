import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcrypt';
import { pool } from '../db/index.js';
import { logger } from '../db/logger.js';
import { logAuditEvent } from '../services/audit.js';
import { z } from 'zod';

const authLogger = logger.child({ module: 'auth' });

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  timezone: z.string().optional().default('UTC'),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export async function authRoutes(fastify: FastifyInstance) {
  // Register - Auto-activates free tier
  fastify.post('/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = registerSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid request',
        details: parseResult.error.errors,
      });
    }

    const { email, password, timezone } = parseResult.data;

    try {
      // Check if user exists
      const existingUser = await pool.query(
        'SELECT id FROM users WHERE email = $1',
        [email]
      );

      if (existingUser.rows.length > 0) {
        return reply.status(409).send({ error: 'Email already registered' });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 12);

      // Create user with FREE tier active
      const result = await pool.query(
        `INSERT INTO users (email, password_hash, timezone, subscription_status)
         VALUES ($1, $2, $3, 'active')
         RETURNING id, email, subscription_status, timezone, created_at`,
        [email, passwordHash, timezone]
      );

      const user = result.rows[0];

      await logAuditEvent({
        actor: user.id,
        action: 'user.register',
        target_type: 'user',
        target_id: user.id,
      });

      // Generate JWT
      const token = fastify.jwt.sign({
        id: user.id,
        email: user.email,
      });

      authLogger.info({ userId: user.id }, 'User registered with free tier');

      return reply.status(201).send({
        token,
        user: {
          id: user.id,
          email: user.email,
          subscription_status: 'active',
          tier: 'free',
          timezone: user.timezone,
          created_at: user.created_at,
        },
      });
    } catch (err) {
      authLogger.error({ err }, 'Registration failed');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // Login
  fastify.post('/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = loginSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid request',
        details: parseResult.error.errors,
      });
    }

    const { email, password } = parseResult.data;

    try {
      const result = await pool.query(
        'SELECT * FROM users WHERE email = $1',
        [email]
      );

      if (result.rows.length === 0) {
        return reply.status(401).send({ error: 'Invalid credentials' });
      }

      const user = result.rows[0];

      // Verify password
      const valid = await bcrypt.compare(password, user.password_hash);

      if (!valid) {
        return reply.status(401).send({ error: 'Invalid credentials' });
      }

      // Generate JWT
      const token = fastify.jwt.sign({
        id: user.id,
        email: user.email,
      });

      authLogger.info({ userId: user.id }, 'User logged in');

      return reply.send({
        token,
        user: {
          id: user.id,
          email: user.email,
          subscription_status: user.subscription_status,
          tier: user.subscription_status === 'active' ? 'free' : 'inactive',
          timezone: user.timezone,
          created_at: user.created_at,
        },
      });
    } catch (err) {
      authLogger.error({ err }, 'Login failed');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // Get current user
  fastify.get('/me', { onRequest: [fastify.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as { id: string };

    try {
      const result = await pool.query(
        'SELECT id, email, subscription_status, timezone, created_at FROM users WHERE id = $1',
        [user.id]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'User not found' });
      }

      const userData = result.rows[0];

      return reply.send({
        id: userData.id,
        email: userData.email,
        subscription_status: userData.subscription_status,
        tier: userData.subscription_status === 'active' ? 'free' : 'inactive',
        timezone: userData.timezone,
        created_at: userData.created_at,
      });
    } catch (err) {
      authLogger.error({ err }, 'Failed to get user');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}
