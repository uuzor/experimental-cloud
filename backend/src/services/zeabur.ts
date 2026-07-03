/**
 * Zeabur Service Manager
 * 
 * Handles dynamic deployment of execution agents to Zeabur.
 * Uses Zeabur REST API for service management.
 */

import { logger } from '../db/logger.js';

const zeaburLogger = logger.child({ module: 'zeabur' });

export interface ZeaburServiceConfig {
  name: string;
  image: string;
  env: Record<string, string>;
  port?: number;
  region?: string;
}

export interface ZeaburService {
  id: string;
  name: string;
  url: string;
  status: 'active' | 'inactive' | 'deploying';
}

export interface ZeaburTemplate {
  id: string;
  name: string;
  image: string;
  defaultEnv: Record<string, string>;
  port: number;
}

// Zeabur API base URL
const ZEABUR_API_BASE = 'https://api.zeabur.com/v1';

export class ZeaburServiceManager {
  private apiKey: string;
  private projectId: string;
  private baseUrl: string;

  constructor(apiKey?: string, projectId?: string) {
    this.apiKey = apiKey || process.env.ZEABUR_API_KEY || '';
    this.projectId = projectId || process.env.ZEABUR_PROJECT_ID || '';
    this.baseUrl = ZEABUR_API_BASE;
  }

  private get headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  isConfigured(): boolean {
    return !!(this.apiKey && this.projectId);
  }

  /**
   * Create a new service from template
   */
  async createService(config: ZeaburServiceConfig): Promise<ZeaburService | null> {
    if (!this.isConfigured()) {
      zeaburLogger.warn('Zeabur not configured, returning mock service');
      return this.getMockService(config.name);
    }

    try {
      const response = await fetch(`${this.baseUrl}/services`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          projectId: this.projectId,
          name: config.name,
          image: config.image,
          env: config.env,
          port: config.port || 3002,
          region: config.region,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        zeaburLogger.error({ status: response.status, error }, 'Failed to create Zeabur service');
        return null;
      }

      const service = await response.json() as ZeaburService;
      zeaburLogger.info({ serviceId: service.id, name: config.name }, 'Zeabur service created');
      
      return service;
    } catch (err) {
      zeaburLogger.error({ err }, 'Error creating Zeabur service');
      return null;
    }
  }

  /**
   * Get service status
   */
  async getService(serviceId: string): Promise<ZeaburService | null> {
    if (!this.isConfigured()) {
      return this.getMockService(serviceId);
    }

    try {
      const response = await fetch(`${this.baseUrl}/services/${serviceId}`, {
        headers: this.headers,
      });

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
   * Delete a service
   */
  async deleteService(serviceId: string): Promise<boolean> {
    if (!this.isConfigured()) {
      zeaburLogger.info({ serviceId }, 'Mock: Would delete service');
      return true;
    }

    try {
      const response = await fetch(`${this.baseUrl}/services/${serviceId}`, {
        method: 'DELETE',
        headers: this.headers,
      });

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
   * Restart a service
   */
  async restartService(serviceId: string): Promise<boolean> {
    if (!this.isConfigured()) {
      zeaburLogger.info({ serviceId }, 'Mock: Would restart service');
      return true;
    }

    try {
      const response = await fetch(`${this.baseUrl}/services/${serviceId}/restart`, {
        method: 'POST',
        headers: this.headers,
      });

      if (!response.ok) {
        zeaburLogger.error({ status: response.status }, 'Failed to restart Zeabur service');
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
   * Update service environment variables
   */
  async updateServiceEnv(serviceId: string, env: Record<string, string>): Promise<boolean> {
    if (!this.isConfigured()) {
      zeaburLogger.info({ serviceId }, 'Mock: Would update env');
      return true;
    }

    try {
      const response = await fetch(`${this.baseUrl}/services/${serviceId}/env`, {
        method: 'PUT',
        headers: this.headers,
        body: JSON.stringify({ env }),
      });

      if (!response.ok) {
        zeaburLogger.error({ status: response.status }, 'Failed to update service env');
        return false;
      }

      zeaburLogger.info({ serviceId }, 'Zeabur service env updated');
      return true;
    } catch (err) {
      zeaburLogger.error({ err }, 'Error updating service env');
      return false;
    }
  }

  /**
   * Get service logs
   */
  async getServiceLogs(serviceId: string, lines: number = 100): Promise<string | null> {
    if (!this.isConfigured()) {
      return '[Mock logs] Service running normally\n[Mock] Last line at 10:00:00';
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/services/${serviceId}/logs?lines=${lines}`,
        { headers: this.headers }
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

  /**
   * Get all services in project
   */
  async listServices(): Promise<ZeaburService[]> {
    if (!this.isConfigured()) {
      return [];
    }

    try {
      const response = await fetch(`${this.baseUrl}/projects/${this.projectId}/services`, {
        headers: this.headers,
      });

      if (!response.ok) {
        zeaburLogger.error({ status: response.status }, 'Failed to list services');
        return [];
      }

      return await response.json() as ZeaburService[];
    } catch (err) {
      zeaburLogger.error({ err }, 'Error listing services');
      return [];
    }
  }

  /**
   * Create a reusable template for execution agents
   */
  async createAgentTemplate(image: string): Promise<ZeaburTemplate | null> {
    const template: ZeaburTemplate = {
      id: `agent-template-${Date.now()}`,
      name: 'Execution Agent Template',
      image,
      defaultEnv: {
        'NODE_ENV': 'production',
        'PORT': '3002',
        'REDIS_URL': '${REDIS_URL}',
        'BACKEND_URL': '${BACKEND_URL}',
        'PLATFORM_API_KEY': '${PLATFORM_API_KEY}',
        'LOG_LEVEL': 'info',
      },
      port: 3002,
    };

    zeaburLogger.info({ template }, 'Agent template created');
    return template;
  }

  /**
   * Deploy execution agent for a user
   */
  async deployExecutionAgent(
    agentId: string,
    agentToken: string,
    config: {
      maxPositionUsd?: number;
      maxLeverage?: number;
      allowedSymbols?: string[];
    }
  ): Promise<ZeaburService | null> {
    const imageName = process.env.EXECUTION_AGENT_IMAGE || 
                      'ghcr.io/uuzor/experimental-cloud/execution-agent:latest';
    const backendUrl = process.env.BACKEND_URL || 'http://backend:3000';

    const serviceConfig: ZeaburServiceConfig = {
      name: `agent-${agentId.substring(0, 8)}`,
      image: imageName,
      port: 3002,
      env: {
        'AGENT_ID': agentId,
        'AGENT_TOKEN': agentToken,
        'BACKEND_URL': backendUrl,
        'REDIS_URL': process.env.REDIS_URL || '',
        'PLATFORM_API_KEY': process.env.PLATFORM_API_KEY || '',
        'MAX_POSITION_USD': String(config.maxPositionUsd || 100),
        'MAX_LEVERAGE': String(config.maxLeverage || 3),
        'ALLOWED_SYMBOLS': (config.allowedSymbols || ['BTC', 'ETH']).join(','),
        'LOG_LEVEL': 'info',
        'NODE_ENV': 'production',
      },
    };

    return this.createService(serviceConfig);
  }

  /**
   * Generate service URL from service ID
   */
  getServiceUrl(serviceId: string): string {
    // Zeabur provides URLs in format: https://{service-name}.zeabur.app
    return `https://${serviceId.substring(0, 8)}.zeabur.app`;
  }

  private getMockService(name: string): ZeaburService {
    return {
      id: `mock-${Date.now()}`,
      name,
      url: `https://${name.toLowerCase().replace(/\s+/g, '-')}.zeabur.app`,
      status: 'active',
    };
  }
}

// Singleton instance
export const zeaburManager = new ZeaburServiceManager();
