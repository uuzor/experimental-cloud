import { pool } from '../db/index.js';
import { logger } from '../db/logger.js';

const auditLogger = logger.child({ module: 'audit' });

export interface AuditLogEntry {
  actor: string;
  action: string;
  target_type: string;
  target_id?: string;
  detail?: Record<string, unknown>;
}

export async function logAuditEvent(entry: AuditLogEntry): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_log (actor, action, target_type, target_id, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        entry.actor,
        entry.action,
        entry.target_type,
        entry.target_id || null,
        entry.detail ? JSON.stringify(entry.detail) : null,
      ]
    );
  } catch (err) {
    logger.error({ err, entry }, 'Failed to write audit log entry');
    // Don't throw - audit log failure shouldn't break the main operation
  }
}
