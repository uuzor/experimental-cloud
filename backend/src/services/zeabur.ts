/**
 * Zeabur Service Provisioner
 * Handles creation/management of per-user execution agent containers on Zeabur
 */

import { logger } from '../db/logger.js';

const zeaburLogger = logger.child({ module: 'zeabur' });

export interface ZeaburServiceConfig {
  name: string;
  image: string;
  env: Record<string, string>;
  port?: number;
}

export interface ZeaburService {
  id: string;
  name: string;
  url: string;
  status: string;
}

/**
 * Create a new Zeabur service for an execution agent
 */
export async function createZeaburService(
  projectId: string,
  agentId: string,
  config: ZeaburServiceConfig
): Promise<ZeaburService | null> {
  const zeaburApiKey = process.env.ZEABUR_API_KEY;
  
  if (!zeaburApiKey) {
    zeaburLogger.warn('ZEABUR_API_KEY not set, skipping service creation');
    // Return mock service for development
    return {
      id: `mock-${agentId}`,
      name: config.name,
      url: `https://agent-${agentId.substring(0, 8)}.zeabur.app`,
      status: 'active',
    };
  }

  try {
    const response = await fetch('https://api.zeabur.com/v1/services', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${zeaburApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId,
        name: config.name,
        template: 'docker',
        image: config.image,
        env: config.env,
        port: config.port || 3002,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      zeaburLogger.error({ status: response.status, error }, 'Failed to create Zeabur service');
      return null;
    }

    const service = await response.json() as ZeaburService;
    zeaburLogger.info({ serviceId: service.id, agentId }, 'Zeabur service created');
    
    return service;
  } catch (err) {
    zeaburLogger.error({ err }, 'Error creating Zeabur service');
    return null;
  }
}

/**
 * Get Zeabur service status
 */
export async function getZeaburService(
  projectId: string,
  serviceId: string
): Promise<ZeaburService | null> {
  const zeaburApiKey = process.env.ZEABUR_API_KEY;
  
  if (!zeaburApiKey) {
    return {
      id: serviceId,
      name: 'mock-service',
      url: `https://agent-${serviceId.substring(0, 8)}.zeabur.app`,
      status: 'active',
    };
  }

  try {
    const response = await fetch(
      `https://api.zeabur.com/v1/services/${serviceId}`,
      {
        headers: {
          'Authorization': `Bearer ${zeaburApiKey}`,
        },
      }
    );

    if (!response.ok) {
      zeaburLogger.error({ status: response.status }, 'Failed to get Zeabur service');
      return null;
    }

    return await response.json() as ZeaburService;
  } catch (err) {
    zeaburLogger.error({ err }, 'Error getting Zeabur service');
    return null;
  }
}

/**
 * Update Zeabur service environment variables
 */
export async function updateZeaburServiceEnv(
  projectId: string,
  serviceId: string,
  env: Record<string, string>
): Promise<boolean> {
  const zeaburApiKey = process.env.ZEABUR_API_KEY;
  
  if (!zeaburApiKey) {
    zeaburLogger.info({ serviceId, env }, 'Mock: Would update service env');
    return true;
  }

  try {
    const response = await fetch(
      `https://api.zeabur.com/v1/services/${serviceId}/env`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${zeaburApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ env }),
      }
    );

    if (!response.ok) {
      zeaburLogger.error({ status: response.status }, 'Failed to update service env');
      return false;
    }

    zeaburLogger.info({ serviceId }, 'Zeabur service env updated');
    return true;
  } catch (err) {
    zeaburLogger.error({ err }, 'Error updating Zeabur service env');
    return false;
  }
}

/**
 * Delete Zeabur service
 */
export async function deleteZeaburService(
  projectId: string,
  serviceId: string
): Promise<boolean> {
  const zeaburApiKey = process.env.ZEABUR_API_KEY;
  
  if (!zeaburApiKey) {
    zeaburLogger.info({ serviceId }, 'Mock: Would delete service');
    return true;
  }

  try {
    const response = await fetch(
      `https://api.zeabur.com/v1/services/${serviceId}`,
      {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${zeaburApiKey}`,
        },
      }
    );

    if (!response.ok) {
      zeaburLogger.error({ status: response.status }, 'Failed to delete Zeabur service');
      return false;
    }

    zeaburLogger.info({ serviceId }, 'Zeabur service deleted');
    return true;
  } catch (err) {
    zeaburLogger.error({ err }, 'Error deleting Zeabur service');
    return false;
  }
}

/**
 * Restart Zeabur service
 */
export async function restartZeaburService(
  projectId: string,
  serviceId: string
): Promise<boolean> {
  const zeaburApiKey = process.env.ZEABUR_API_KEY;
  
  if (!zeaburApiKey) {
    zeaburLogger.info({ serviceId }, 'Mock: Would restart service');
    return true;
  }

  try {
    const response = await fetch(
      `https://api.zeabur.com/v1/services/${serviceId}/restart`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${zeaburApiKey}`,
        },
      }
    );

    if (!response.ok) {
      zeaburLogger.error({ status: response.status }, 'Failed to restart service');
      return false;
    }

    zeaburLogger.info({ serviceId }, 'Zeabur service restarted');
    return true;
  } catch (err) {
    zeaburLogger.error({ err }, 'Error restarting Zeabur service');
    return false;
  }
}

/**
 * Get service logs
 */
export async function getZeaburServiceLogs(
  projectId: string,
  serviceId: string,
  lines: number = 100
): Promise<string | null> {
  const zeaburApiKey = process.env.ZEABUR_API_KEY;
  
  if (!zeaburApiKey) {
    return '[Mock logs] Service running normally';
  }

  try {
    const response = await fetch(
      `https://api.zeabur.com/v1/services/${serviceId}/logs?lines=${lines}`,
      {
        headers: {
          'Authorization': `Bearer ${zeaburApiKey}`,
        },
      }
    );

    if (!response.ok) {
      return null;
    }

    return await response.text();
  } catch (err) {
    zeaburLogger.error({ err }, 'Error getting service logs');
    return null;
  }
}
