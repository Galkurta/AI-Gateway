import type {
  ProviderAdapter, ProviderConfig, NormalizedRequest,
  NormalizedResponse, StreamChunk, ModelInfo, ChatMessage
} from '../types.js';
import { refreshOAuthToken } from '../oauth-refresh.js';

const DEFAULT_BASE = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const CLAUDE_OAUTH_BETA_FLAGS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'advanced-tool-use-2025-11-20',
  'effort-2025-11-24',
  'structured-outputs-2025-12-15',
  'fast-mode-2026-02-01',
  'redact-thinking-2026-02-12',
  'token-efficient-tools-2026-03-28',
];

function normalizeBase(url: string): string {
  return url.replace(/\/v\d+\/?$/, '').replace(/\/$/, '');
}

function mapStainlessOs(): string {
  switch (process.platform) {
    case 'darwin': return 'MacOS';
    case 'win32': return 'Windows';
    case 'linux': return 'Linux';
    case 'freebsd': return 'FreeBSD';
    default: return `Other::${process.platform}`;
  }
}

function mapStainlessArch(): string {
  switch (process.arch) {
    case 'x64': return 'x64';
    case 'arm64': return 'arm64';
    case 'ia32': return 'x86';
    default: return `other::${process.arch}`;
  }
}

function mergeBetaFlags(...values: Array<string | undefined>): string {
  const flags = new Set<string>();
  for (const value of values) {
    for (const flag of (value ?? '').split(',')) {
      const clean = flag.trim();
      if (clean) flags.add(clean);
    }
  }
  return Array.from(flags).join(',');
}

function claudeOauthHeaders(extraHeaders: Record<string, string>): Record<string, string> {
  const beta = mergeBetaFlags(
    CLAUDE_OAUTH_BETA_FLAGS.join(','),
    extraHeaders['anthropic-beta'],
    extraHeaders['Anthropic-Beta'],
  );
  delete extraHeaders['Anthropic-Beta'];
  return {
    'anthropic-beta': beta,
    'anthropic-dangerous-direct-browser-access': extraHeaders['anthropic-dangerous-direct-browser-access'] ?? 'true',
    'User-Agent': extraHeaders['User-Agent'] ?? extraHeaders['user-agent'] ?? 'claude-cli/2.1.92 (external, sdk-cli)',
    'X-App': extraHeaders['X-App'] ?? extraHeaders['x-app'] ?? 'cli',
    'X-Stainless-Helper-Method': extraHeaders['X-Stainless-Helper-Method'] ?? extraHeaders['x-stainless-helper-method'] ?? 'stream',
    'X-Stainless-Retry-Count': extraHeaders['X-Stainless-Retry-Count'] ?? extraHeaders['x-stainless-retry-count'] ?? '0',
    'X-Stainless-Runtime-Version': extraHeaders['X-Stainless-Runtime-Version'] ?? extraHeaders['x-stainless-runtime-version'] ?? `v${process.versions.node}`,
    'X-Stainless-Package-Version': extraHeaders['X-Stainless-Package-Version'] ?? extraHeaders['x-stainless-package-version'] ?? '0.80.0',
    'X-Stainless-Runtime': extraHeaders['X-Stainless-Runtime'] ?? extraHeaders['x-stainless-runtime'] ?? 'node',
    'X-Stainless-Lang': extraHeaders['X-Stainless-Lang'] ?? extraHeaders['x-stainless-lang'] ?? 'js',
    'X-Stainless-Arch': extraHeaders['X-Stainless-Arch'] ?? extraHeaders['x-stainless-arch'] ?? mapStainlessArch(),
    'X-Stainless-Os': extraHeaders['X-Stainless-Os'] ?? extraHeaders['x-stainless-os'] ?? mapStainlessOs(),
    'X-Stainless-Timeout': extraHeaders['X-Stainless-Timeout'] ?? extraHeaders['x-stainless-timeout'] ?? '600',
  };
}

function buildHeaders(config: ProviderConfig): Record<string, string> {
  const extraHeaders = { ...(config.extraHeaders ?? {}) };
  const authScheme = extraHeaders['X-Gateway-Auth-Scheme'] ?? extraHeaders['x-gateway-auth-scheme'];
  delete extraHeaders['X-Gateway-Auth-Scheme'];
  delete extraHeaders['x-gateway-auth-scheme'];
  const base = normalizeBase(config.baseUrl ?? DEFAULT_BASE);
  const oauthHeaders = authScheme === 'bearer' && base.includes('api.anthropic.com')
    ? claudeOauthHeaders(extraHeaders)
    : {};

  return {
    'Content-Type': 'application/json',
    'anthropic-version': API_VERSION,
    ...(authScheme === 'bearer'
      ? { Authorization: `Bearer ${config.apiKey ?? ''}` }
      : { 'x-api-key': config.apiKey ?? '' }),
    ...oauthHeaders,
    ...extraHeaders,
  };
}

async function fetchWithAuthRetry(config: ProviderConfig, url: string, init: RequestInit = {}): Promise<Response> {
  await refreshOAuthToken(config);
  let res = await fetch(url, { ...init, headers: buildHeaders(config) });
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => {});
    await refreshOAuthToken(config, true);
    res = await fetch(url, { ...init, headers: buildHeaders(config) });
  }
  return res;
}

function toAnthropicMessages(messages: ChatMessage[]): { system?: string; messages: object[] } {
  let system: string | undefined;
  const out: object[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      system = Array.isArray(m.content) ? m.content.map(p => ('text' in p ? p.text : '')).join('') : m.content;
      continue;
    }
    const role = m.role === 'tool' ? 'user' : m.role;
    out.push({
      role,
      content: Array.isArray(m.content)
        ? m.content.map(p => {
            if (p.type === 'image_url') return { type: 'image', source: { type: 'url', url: p.image_url?.url } };
            if (p.type === 'tool_result') return p;
            return { type: 'text', text: p.text ?? '' };
          })
        : m.content,
    });
  }
  return { system, messages: out };
}

export const AnthropicAdapter: ProviderAdapter = {
  type: 'anthropic',

  async listModels(config) {
    const base = normalizeBase(config.baseUrl ?? DEFAULT_BASE);
    const res = await fetchWithAuthRetry(config, `${base}/v1/models`);
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json() as { data: { id: string; display_name?: string; created_at?: string }[] };
    return (data.data ?? []).map(m => ({
      id: m.id,
      name: m.display_name ?? m.id,
      owned_by: 'anthropic',
      created: m.created_at ? new Date(m.created_at).getTime() / 1000 : undefined,
    }));
  },

  async complete(config, req) {
    const base = normalizeBase(config.baseUrl ?? DEFAULT_BASE);
    const { system, messages } = toAnthropicMessages(req.messages);
    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      max_tokens: req.max_tokens ?? 4096,
    };
    if (system) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.stop) body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];

    const res = await fetchWithAuthRetry(config, `${base}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    const data = await res.json() as {
      id: string; model: string; stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
      content: { type: string; text: string }[];
    };

    return {
      id: data.id,
      model: data.model,
      content: data.content.filter(c => c.type === 'text').map(c => c.text).join(''),
      input_tokens: data.usage.input_tokens,
      output_tokens: data.usage.output_tokens,
      finish_reason: data.stop_reason ?? 'end_turn',
    };
  },

  async stream(config, req, onChunk) {
    const base = normalizeBase(config.baseUrl ?? DEFAULT_BASE);
    const { system, messages } = toAnthropicMessages(req.messages);
    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      max_tokens: req.max_tokens ?? 4096,
      stream: true,
    };
    if (system) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.stop) body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];

    const res = await fetchWithAuthRetry(config, `${base}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;

        try {
          const evt = JSON.parse(raw) as {
            type: string;
            delta?: { type: string; text?: string };
            message?: { usage?: { input_tokens: number; output_tokens: number } };
            usage?: { input_tokens?: number; output_tokens?: number };
            index?: number;
          };

          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            onChunk({ delta: evt.delta.text ?? '', done: false });
          } else if (evt.type === 'message_start' && evt.message?.usage) {
            inputTokens = evt.message.usage.input_tokens;
          } else if (evt.type === 'message_delta' && evt.usage) {
            outputTokens = evt.usage.output_tokens ?? 0;
          } else if (evt.type === 'message_stop') {
            onChunk({ delta: '', done: true, input_tokens: inputTokens, output_tokens: outputTokens });
          }
        } catch {
          // ignore parse errors in stream
        }
      }
    }
  },
};

function hardcodedModels(): ModelInfo[] {
  return [
    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', owned_by: 'anthropic' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', owned_by: 'anthropic' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', owned_by: 'anthropic' },
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', owned_by: 'anthropic' },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', owned_by: 'anthropic' },
    { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', owned_by: 'anthropic' },
  ];
}
