/**
 * ZenMux web adapter.
 * Uses a logged-in zenmux.ai browser session extracted by the Chrome extension.
 * If the session exposes an access token/API key in browser storage, the
 * extension stores it as cookies and this adapter sends it as a bearer token.
 */
import type {
  ChatMessage, ModelInfo, NormalizedRequest, NormalizedResponse,
  ProviderAdapter, ProviderConfig, StreamChunk,
} from '../types.js';
import { classifyModelCapability } from '../capabilities.js';
import { db } from '../../db/index.js';

const SITE_BASE = 'https://zenmux.ai';

function cookieHeader(config: ProviderConfig): string {
  return Object.entries(config.cookies ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function apiBase(config: ProviderConfig): string {
  const raw = (config.baseUrl ?? SITE_BASE).replace(/\/$/, '');
  if (/\/api\/v\d+$/i.test(raw)) return raw;
  const origin = new URL(raw).origin;
  return `${origin}/api/v1`;
}

function bearer(config: ProviderConfig): string | undefined {
  const cookies = config.cookies ?? {};
  return config.apiKey
    ?? cookies.__zenmux_bearer
    ?? cookies.zenmux_bearer
    ?? cookies.zenmux_access_token
    ?? cookies.access_token
    ?? cookies.oauth_access_token
    ?? cookies.zenmux_api_key
    ?? cookies.api_key;
}

function csrf(config: ProviderConfig): string | undefined {
  const cookies = config.cookies ?? {};
  return cookies.ctoken
    ?? cookies['XSRF-TOKEN']
    ?? cookies['csrf-token']
    ?? cookies.csrfToken
    ?? cookies.csrf_token
    ?? cookies.__csrf
    ?? cookies.zenmux_ctoken
    ?? cookies.zenmux_csrf_token;
}

function splitSetCookie(header: string | null): string[] {
  if (!header) return [];
  return header.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g).map(part => part.trim()).filter(Boolean);
}

function responseCookies(res: Response): { values: Record<string, string>; expiresAt: Record<string, string> } {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const rawCookies = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : splitSetCookie(res.headers.get('set-cookie'));
  const values: Record<string, string> = {};
  const expiresAt: Record<string, string> = {};

  for (const raw of rawCookies) {
    const parts = raw.split(';').map(part => part.trim());
    const [nameValue, ...attrs] = parts;
    const index = nameValue.indexOf('=');
    if (index <= 0) continue;
    const name = nameValue.slice(0, index);
    values[name] = nameValue.slice(index + 1);

    let maxAge: number | undefined;
    let expires: string | undefined;
    for (const attr of attrs) {
      const attrIndex = attr.indexOf('=');
      const key = (attrIndex >= 0 ? attr.slice(0, attrIndex) : attr).toLowerCase();
      const value = attrIndex >= 0 ? attr.slice(attrIndex + 1) : '';
      if (key === 'max-age') {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) maxAge = parsed;
      }
      if (key === 'expires') expires = value;
    }
    if (maxAge !== undefined) {
      expiresAt[name] = new Date(Date.now() + maxAge * 1000).toISOString();
    } else if (expires) {
      const parsed = Date.parse(expires);
      if (Number.isFinite(parsed)) expiresAt[name] = new Date(parsed).toISOString();
    }
  }

  return { values, expiresAt };
}

function saveResponseCookies(config: ProviderConfig, res: Response): void {
  const parsed = responseCookies(res);
  if (!Object.keys(parsed.values).length) return;
  const currentExpires = (() => {
    try {
      const raw = config.cookies?.zenmux_cookie_expires_at;
      return raw ? JSON.parse(raw) as Record<string, string> : {};
    } catch {
      return {};
    }
  })();
  const nextCookies = {
    ...(config.cookies ?? {}),
    ...parsed.values,
    ...(parsed.values.ctoken ? { zenmux_ctoken: parsed.values.ctoken, zenmux_csrf_token: parsed.values.ctoken } : {}),
    zenmux_cookie_expires_at: JSON.stringify({ ...currentExpires, ...parsed.expiresAt }),
    zenmux_cookie_refreshed_at: new Date().toISOString(),
  };
  config.cookies = nextCookies;
  const serialized = JSON.stringify(nextCookies);
  const now = Date.now();
  if (config.accountId) {
    db.prepare('UPDATE provider_accounts SET cookies = ?, updated_at = ? WHERE id = ?')
      .run(serialized, now, config.accountId);
  } else {
    db.prepare('UPDATE providers SET cookies = ?, updated_at = ? WHERE id = ?')
      .run(serialized, now, config.id);
  }
}

function buildHeaders(config: ProviderConfig): Record<string, string> {
  const token = bearer(config);
  const csrfToken = csrf(config);
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(cookieHeader(config) ? { Cookie: cookieHeader(config) } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(csrfToken ? {
      'X-CSRF-Token': csrfToken,
      'x-csrf-token': csrfToken,
      'x-ctoken': csrfToken,
    } : {}),
    Origin: SITE_BASE,
    Referer: `${SITE_BASE}/settings/chat`,
    'HTTP-Referer': 'http://localhost:3000',
    'X-Title': 'AI Gateway',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ...config.extraHeaders,
  };
}

async function refreshSessionCookies(config: ProviderConfig): Promise<void> {
  const res = await fetch(SITE_BASE, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...(cookieHeader(config) ? { Cookie: cookieHeader(config) } : {}),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });
  saveResponseCookies(config, res);
}

async function fetchZenMux(config: ProviderConfig, url: string, init: RequestInit): Promise<Response> {
  let res = await fetch(url, init);
  saveResponseCookies(config, res);
  if (res.status !== 401 && res.status !== 403) return res;

  await refreshSessionCookies(config);
  res = await fetch(url, {
    ...init,
    headers: buildHeaders(config),
  });
  saveResponseCookies(config, res);
  return res;
}

function contentToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map(part => part.type === 'text' ? part.text ?? '' : part.image_url?.url ?? '')
    .filter(Boolean)
    .join('\n');
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

type ZenMuxPrice = {
  value?: number;
  unit?: string;
  currency?: string;
};

type ZenMuxModel = {
  id: string;
  name?: string;
  display_name?: string;
  owned_by?: string;
  created?: number;
  context_length?: number;
  input_modalities?: string[];
  output_modalities?: string[];
  capabilities?: Record<string, unknown>;
  pricings?: Record<string, ZenMuxPrice[]>;
};

function priceValue(prices: ZenMuxPrice[] | undefined): number | undefined {
  const values = (prices ?? [])
    .map(price => price.value)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (!values.length) return undefined;
  return Math.min(...values);
}

function hasPositivePricing(pricings: Record<string, ZenMuxPrice[]> | undefined): boolean {
  return Object.values(pricings ?? {}).some(prices =>
    prices.some(price => typeof price.value === 'number' && price.value > 0)
  );
}

function pricingSummary(pricings: Record<string, ZenMuxPrice[]> | undefined): string | undefined {
  if (!pricings) return undefined;
  const prompt = priceValue(pricings.prompt);
  const completion = priceValue(pricings.completion);
  const currency = pricings.prompt?.[0]?.currency
    ?? pricings.completion?.[0]?.currency
    ?? Object.values(pricings).flat()[0]?.currency
    ?? 'USD';
  const unit = pricings.prompt?.[0]?.unit
    ?? pricings.completion?.[0]?.unit
    ?? Object.values(pricings).flat()[0]?.unit
    ?? 'perMTokens';

  if (prompt === undefined && completion === undefined) return undefined;
  const fmt = (value: number | undefined) => value === undefined ? '?' : `${currency === 'USD' ? '$' : `${currency} `}${value}`;
  return `${fmt(prompt)} in / ${fmt(completion)} out ${unit}`;
}

function features(model: ZenMuxModel): string[] | undefined {
  const out: string[] = [];
  if (model.capabilities?.reasoning === true) out.push('reasoning');
  if (model.input_modalities?.includes('image')) out.push('vision');
  if (model.input_modalities?.includes('file')) out.push('files');
  if (model.output_modalities?.includes('image')) out.push('image-out');
  if (model.output_modalities?.includes('audio')) out.push('audio-out');
  return out.length ? out : undefined;
}

function requestBody(req: NormalizedRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model || 'qwen/qwen3-max',
    messages: req.messages,
    stream,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.stop) body.stop = req.stop;
  if (stream) body.stream_options = { include_usage: true };
  return body;
}

function inputText(req: NormalizedRequest): string {
  return req.messages.map(message => contentToText(message.content)).join('\n');
}

function authError(status: number): Error {
  return new Error(
    `ZenMux Web session rejected (${status}). Re-extract cookies from zenmux.ai while logged in, or use the ZenMux API preset with an API key.`
  );
}

export const ZenMuxWebAdapter: ProviderAdapter = {
  type: 'zenmux-web',

  async listModels(config): Promise<ModelInfo[]> {
    const res = await fetchZenMux(config, `${apiBase(config)}/models`, {
      headers: buildHeaders(config),
    });
    const text = await res.text().catch(() => res.statusText);
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw authError(res.status);
      throw new Error(`ZenMux Web models error ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = JSON.parse(text) as { data?: ZenMuxModel[] };
    return (data.data ?? []).map(model => ({
      id: model.id,
      name: model.display_name ?? model.name ?? model.id,
      owned_by: model.owned_by,
      created: model.created,
      context_length: model.context_length,
      billing: hasPositivePricing(model.pricings) ? 'premium' : 'free',
      pricing_summary: pricingSummary(model.pricings),
      input_modalities: model.input_modalities,
      output_modalities: model.output_modalities,
      features: features(model),
      capability: classifyModelCapability(model.id, model.owned_by),
    }));
  },

  async complete(config, req): Promise<NormalizedResponse> {
    const res = await fetchZenMux(config, `${apiBase(config)}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify(requestBody(req, false)),
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw authError(res.status);
      throw new Error(`ZenMux Web error ${res.status}: ${text.slice(0, 500)}`);
    }
    const data = JSON.parse(text) as {
      id?: string;
      model?: string;
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      id: data.id ?? `zenmux-web-${Date.now()}`,
      model: data.model ?? req.model,
      content: data.choices?.[0]?.message?.content ?? '',
      input_tokens: data.usage?.prompt_tokens ?? estimateTokens(inputText(req)),
      output_tokens: data.usage?.completion_tokens ?? estimateTokens(data.choices?.[0]?.message?.content ?? ''),
      finish_reason: data.choices?.[0]?.finish_reason ?? 'stop',
    };
  },

  async stream(config, req, onChunk): Promise<void> {
    const res = await fetchZenMux(config, `${apiBase(config)}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify(requestBody(req, true)),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => res.statusText);
      if (res.status === 401 || res.status === 403) throw authError(res.status);
      throw new Error(`ZenMux Web stream error ${res.status}: ${text.slice(0, 500)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;

    const processLine = (line: string) => {
      if (!line.startsWith('data:')) return;
      const raw = line.slice(5).trim();
      if (!raw) return;
      if (raw === '[DONE]') {
        onChunk({ delta: '', done: true, input_tokens: inputTokens, output_tokens: outputTokens, finish_reason: 'stop' });
        return;
      }
      try {
        const evt = JSON.parse(raw) as {
          choices?: { delta?: { content?: string }; finish_reason?: string }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const delta = evt.choices?.[0]?.delta?.content;
        if (delta) onChunk({ delta, done: false });
        if (evt.usage) {
          inputTokens = evt.usage.prompt_tokens ?? inputTokens;
          outputTokens = evt.usage.completion_tokens ?? outputTokens;
        }
        const finish = evt.choices?.[0]?.finish_reason;
        if (finish) onChunk({ delta: '', done: true, input_tokens: inputTokens, output_tokens: outputTokens, finish_reason: finish });
      } catch {
        // Ignore keepalive or non-JSON stream events.
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) processLine(line.replace(/\r$/, ''));
    }
    if (buffer.trim()) processLine(buffer);
  },
};
