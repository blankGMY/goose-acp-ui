/**
 * Client for the gateway's management API.
 *
 * The Pi's goose-web gateway serves this UI and, next to it, a small
 * /api/* surface that manages Goose's on-disk state (extensions in
 * config.yaml, recipe files, scheduled jobs) - the things Goose Desktop
 * manages locally but goose-serve exposes no API for. Requests are
 * same-origin, so the gate cookie set at login is sent automatically.
 */

export interface ExtensionInfo {
  key: string;
  name: string;
  description: string;
  type: string; // platform | builtin | stdio | streamable_http
  enabled: boolean;
  bundled: boolean;
  summary: string; // uri, or cmd + args (never contains secrets)
  hasAuth: boolean;
}

export interface RecipeParameter {
  key: string;
  description: string;
  requirement: string; // 'required' | 'optional' | ''
  default: string;
}

export interface RecipeInfo {
  file: string;
  title: string;
  description: string;
  instructions: string;
  prompt: string;
  parameters: RecipeParameter[];
}

export interface ScheduleInfo {
  id: string;
  status: string;
  cron: string;
  recipeSource: string;
  lastRun: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  files: string[];
  builtin: boolean;
}

export interface CodexUsageWindow {
  used_percent: number | null;
  window_seconds: number | null;
  reset_at: number | null;
}

export interface CodexUsage {
  ok: boolean;
  plan_type: string | null;
  primary: CodexUsageWindow;
  secondary: CodexUsageWindow;
}

/** ChatGPT plan quota (5-hour + weekly windows), served by the gateway. */
export function codexUsage(): Promise<CodexUsage> {
  return gatewayApi<CodexUsage>('/api/codex-usage');
}

export interface PoolWindow {
  used: number;
  reset: number; // epoch seconds
}

export interface PoolAccount {
  id: string;
  account: string; // masked account id
  priority: number;
  state: string; // active | standby | parked
  is_active: boolean;
  park_reason: string | null; // capped | invalid | manual
  parked_until: number | null; // epoch seconds
  health: string; // ok | capped | invalid | error | unknown
  plan?: string;
  primary?: PoolWindow;
  secondary?: PoolWindow;
}

export interface PoolStatus {
  active: string;
  accounts: PoolAccount[];
}

/** GPT account pool: accounts, state and quota, served by the gateway. */
export function poolStatus(): Promise<PoolStatus> {
  return gatewayApi<PoolStatus>('/api/pool/status');
}

export async function gatewayApi<T>(path: string, payload?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data as T;
}
