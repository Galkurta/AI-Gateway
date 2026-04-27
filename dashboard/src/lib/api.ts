const BASE = '/api';

function adminHeaders(): HeadersInit {
  const pwd = localStorage.getItem('adminPassword') ?? '';
  return { 'Content-Type': 'application/json', 'x-admin-password': pwd };
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: adminHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

const get = <T>(path: string) => req<T>('GET', path);
const post = <T>(path: string, body: unknown) => req<T>('POST', path, body);
const put = <T>(path: string, body: unknown) => req<T>('PUT', path, body);
const patch = <T>(path: string, body: unknown) => req<T>('PATCH', path, body);
const del = <T>(path: string) => req<T>('DELETE', path);

export type Provider = {
  id: string; name: string; type: string;
  base_url: string | null; api_key: string | null;
  auth_type?: 'oauth' | 'cookies' | 'key' | null;
  account_count?: number;
  enabled_account_count?: number;
  extra_headers?: string | null;
  cookies: string | null; enabled: number;
  priority: number; notes: string | null;
  created_at: number; updated_at: number;
};

export type ProviderAccount = {
  id: string;
  provider_id: string;
  name: string;
  auth_type: string | null;
  api_key: string | null;
  cookies: string | null;
  extra_headers: string | null;
  enabled: number;
  priority: number;
  requests_count: number;
  error_count: number;
  last_used_at: number | null;
  last_error_at: number | null;
  cooldown_until: number | null;
  created_at: number;
  updated_at: number;
};

export type ModelRoute = {
  id: string; pattern: string; provider_id: string;
  provider_name: string; model_override: string | null; enabled: number;
};

export type ModelAlias = {
  id: string;
  alias: string;
  provider_id: string;
  provider_name: string;
  upstream_model: string;
  fork: number;
  created_at: number;
  updated_at: number;
};

export type GatewayKey = {
  id: string; key_preview: string; name: string | null;
  enabled: number; requests_count: number; tokens_count: number;
  created_at: number; last_used_at: number | null;
};

export type RequestLog = {
  id: string; provider_id: string | null; model: string | null;
  endpoint: string | null; input_tokens: number | null;
  output_tokens: number | null; total_tokens: number | null;
  status: number | null; latency: number | null; error: string | null;
  stream: number; created_at: number;
  request_preview: string | null; response_preview: string | null;
};

export type Stats = {
  total: number; today: number;
  tokensTotal: number; tokensToday: number;
  errors: number; activeProviders: number;
  perModel: { model: string; requests: number; tokens: number }[];
  hourly: { hour: number; requests: number; tokens: number }[];
};

export type ModelInfo = {
  id: string; name: string; owned_by?: string;
  capability?: ModelCapability;
  context_length?: number; provider_id: string; provider_name: string;
  billing?: 'free' | 'premium' | 'unknown';
  pricing_summary?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  features?: string[];
  source_id?: string; alias_of?: string; forked_alias?: boolean;
};

export type ModelCapability =
  | 'chat'
  | 'embedding'
  | 'image'
  | 'tts'
  | 'transcription'
  | 'video'
  | 'rerank'
  | 'moderation'
  | 'unknown';

export type ModelsResult = {
  models: ModelInfo[];
  errors: { provider_id: string; provider_name: string; error: string }[];
};

export type ModelTestResult = {
  ok: boolean;
  model: string;
  resolvedModel: string;
  provider: { id: string; name: string; type: string };
  capability?: ModelCapability;
  latency: number;
  content?: string;
  error?: string;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
};

export type OAuthStartResult = {
  state: string;
  authUrl: string;
  userCode?: string;
  verificationUri?: string;
};

export type OAuthStatusResult =
  | { status: 'pending'; provider: string; createdAt: number }
  | { status: 'complete'; provider: string; createdAt: number; providerId: string; email?: string }
  | { status: 'error'; provider: string; createdAt: number; error: string };

export type OAuthProvider =
  | 'iflow' | 'qwen' | 'github' | 'kimi-coding' | 'kilocode' | 'codebuddy' | 'claude' | 'cline'
  | 'gemini-cli' | 'antigravity' | 'codex' | 'kiro' | 'gitlab';

export type Settings = {
  token_saver_enabled: boolean;
};

export type LogsResponse = {
  logs: RequestLog[]; total: number; page: number; limit: number; pages: number;
};

type ProviderPayload = Omit<Partial<Provider>, 'cookies' | 'extra_headers'> & {
  cookies?: object;
  extra_headers?: object;
};

type ProviderAccountPayload = Omit<Partial<ProviderAccount>, 'cookies' | 'extra_headers' | 'enabled'> & {
  cookies?: object | null;
  extra_headers?: object | null;
  enabled?: boolean;
};

export const api = {
  stats: () => get<Stats>('/stats'),
  providers: {
    list: () => get<Provider[]>('/providers'),
    get: (id: string) => get<Provider>(`/providers/${id}`),
    create: (data: ProviderPayload) =>
      post<{ id: string }>('/providers', data),
    update: (id: string, data: ProviderPayload) =>
      put<{ ok: boolean }>(`/providers/${id}`, data),
    delete: (id: string) => del<{ ok: boolean }>(`/providers/${id}`),
    updateCookies: (id: string, cookies: Record<string, string>) =>
      post<{ ok: boolean }>(`/providers/${id}/cookies`, { cookies }),
    accounts: {
      list: (providerId: string) => get<ProviderAccount[]>(`/providers/${providerId}/accounts`),
      create: (providerId: string, data: ProviderAccountPayload) =>
        post<{ id: string }>(`/providers/${providerId}/accounts`, data),
      update: (providerId: string, accountId: string, data: ProviderAccountPayload) =>
        put<{ ok: boolean }>(`/providers/${providerId}/accounts/${accountId}`, data),
      delete: (providerId: string, accountId: string) =>
        del<{ ok: boolean }>(`/providers/${providerId}/accounts/${accountId}`),
    },
  },
  routes: {
    list: () => get<ModelRoute[]>('/model-routes'),
    create: (data: { pattern: string; provider_id: string; model_override?: string }) =>
      post<{ id: string }>('/model-routes', data),
    delete: (id: string) => del<{ ok: boolean }>(`/model-routes/${id}`),
  },
  aliases: {
    list: () => get<ModelAlias[]>('/model-aliases'),
    create: (data: { alias: string; provider_id: string; upstream_model: string; fork?: boolean }) =>
      post<{ ok: boolean }>('/model-aliases', data),
    update: (id: string, data: { alias?: string; provider_id?: string; upstream_model?: string; fork?: boolean }) =>
      put<{ ok: boolean }>(`/model-aliases/${id}`, data),
    delete: (id: string) => del<{ ok: boolean }>(`/model-aliases/${id}`),
  },
  settings: {
    get: () => get<Settings>('/settings'),
    update: (data: Partial<Settings>) => put<{ ok: boolean }>('/settings', data),
  },
  keys: {
    list: () => get<GatewayKey[]>('/keys'),
    create: (name?: string) => post<{ id: string; key: string; preview: string }>('/keys', { name }),
    delete: (id: string) => del<{ ok: boolean }>(`/keys/${id}`),
    toggle: (id: string, enabled: boolean) => patch<{ ok: boolean }>(`/keys/${id}`, { enabled }),
  },
  logs: {
    list: (params?: { page?: number; limit?: number; model?: string; provider?: string; status?: string }) => {
      const qs = new URLSearchParams();
      if (params?.page) qs.set('page', String(params.page));
      if (params?.limit) qs.set('limit', String(params.limit));
      if (params?.model) qs.set('model', params.model);
      if (params?.provider) qs.set('provider', params.provider);
      if (params?.status) qs.set('status', params.status);
      return get<LogsResponse>(`/logs?${qs}`);
    },
    clear: () => del<{ ok: boolean }>('/logs'),
  },
  models: {
    list: () => get<ModelsResult>('/models'),
    test: (data: { model: string; prompt?: string; provider_id?: string }) => post<ModelTestResult>('/models/test', data),
  },
  oauth: {
    start: (provider: OAuthProvider, targetProviderId?: string) =>
      post<OAuthStartResult>(`/oauth/${provider}/start`, targetProviderId ? { target_provider_id: targetProviderId } : {}),
    status: (provider: OAuthProvider, state: string) => get<OAuthStatusResult>(`/oauth/${provider}/status/${encodeURIComponent(state)}`),
  },
};
