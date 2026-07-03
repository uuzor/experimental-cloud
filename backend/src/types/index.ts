// User entity
export interface User {
  id: string;
  email: string;
  created_at: Date;
  subscription_status: 'inactive' | 'active' | 'past_due' | 'canceled';
  stripe_customer_id: string | null;
  timezone: string;
}

// Hyperliquid agent wallet (API wallet, never master key)
export interface HlAgentWallet {
  id: string;
  user_id: string;
  agent_address: string;
  agent_name: string;
  encrypted_agent_key: string;
  master_address: string;
  registered_at: Date;
  status: 'active' | 'revoked' | 'expired';
}

// Tracked top-trader wallets (curated signal source list)
export interface TrackedWallet {
  id: string;
  address: string;
  label: string | null;
  added_at: Date;
  active: boolean;
}

// Signal events emitted by the tracker service
export interface Signal {
  id: string;
  tracked_wallet_id: string;
  asset: string;
  side: 'LONG' | 'SHORT' | 'CLOSE';
  size_delta: number;
  leverage: number | null;
  entry_price: number | null;
  detected_at: Date;
  raw_payload: Record<string, unknown>;
}

// User execution agent config (maps 1:1 to a Zeabur service)
export interface ExecutionAgent {
  id: string;
  user_id: string;
  zeabur_service_id: string | null;
  zeabur_project_id: string | null;
  agent_internal_url: string | null;
  agent_control_token_hash: string | null;
  status: ExecutionAgentStatus;
  max_position_usd: number;
  max_leverage: number;
  daily_loss_limit_usd: number | null;
  llm_filter_enabled: boolean;
  created_at: Date;
  last_heartbeat_at: Date | null;
}

export type ExecutionAgentStatus =
  | 'provisioning'
  | 'active'
  | 'disconnected'
  | 'suspended'
  | 'terminated'
  | 'paused';

// Executions resulting from signals (append-only audit trail)
export interface Execution {
  id: string;
  execution_agent_id: string;
  signal_id: string | null;
  hl_order_id: string | null;
  asset: string;
  side: 'LONG' | 'SHORT' | 'CLOSE';
  size: number;
  requested_at: Date;
  filled_at: Date | null;
  fill_price: number | null;
  status: ExecutionStatus;
  error_detail: string | null;
  jitter_ms_applied: number | null;
}

export type ExecutionStatus =
  | 'pending'
  | 'filled'
  | 'rejected'
  | 'error';

// Heartbeats (rolling - can be pruned aggressively)
export interface AgentHeartbeat {
  id: number;
  execution_agent_id: string;
  received_at: Date;
  status: 'ok' | 'degraded' | 'error';
}

// Billing (flat subscription)
export interface Subscription {
  id: string;
  user_id: string;
  stripe_subscription_id: string | null;
  plan: string;
  status: string;
  current_period_end: Date;
}

// Audit log - every privileged action
export interface AuditLog {
  id: number;
  actor: string; // user_id, 'system', or admin id
  action: string;
  target_type: string;
  target_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: Date;
}

// API request/response types
export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: Omit<User, 'id'> & { id: string };
}

export interface RegisterRequest {
  email: string;
  password: string;
  timezone?: string;
}

export interface CreateExecutionAgentRequest {
  max_position_usd: number;
  max_leverage?: number;
  daily_loss_limit_usd?: number | null;
  llm_filter_enabled?: boolean;
}

export interface UpdateExecutionAgentConfigRequest {
  max_position_usd?: number;
  max_leverage?: number;
  daily_loss_limit_usd?: number | null;
  llm_filter_enabled?: boolean;
}

// Internal types for agent communication
export interface AgentHandshakeResponse {
  redis_stream_token: string;
  redis_stream_url: string;
  config: {
    max_position_usd: number;
    max_leverage: number;
    daily_loss_limit_usd: number | null;
    llm_filter_enabled: boolean;
  };
}

export interface TelemetryPayload {
  agent_id: string;
  type: 'heartbeat' | 'execution' | 'error';
  data: {
    status?: 'ok' | 'degraded' | 'error';
    execution?: Partial<Execution>;
    error?: {
      message: string;
      stack?: string;
    };
  };
}
