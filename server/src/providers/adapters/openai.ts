import type {
  ProviderAdapter, ProviderConfig, NormalizedRequest,
  NormalizedResponse, StreamChunk, ModelInfo
} from '../types.js';
import { classifyModelCapability } from '../capabilities.js';
import { db } from '../../db/index.js';
import { refreshOAuthToken } from '../oauth-refresh.js';

const DEFAULT_BASE = 'https://api.openai.com';
const GITHUB_COPILOT = {
  CLIENT_ID: 'Iv1.b507a08c87ecfe98',
  VSCODE_VERSION: '1.110.0',
  COPILOT_CHAT_VERSION: '0.38.0',
  USER_AGENT: 'GitHubCopilotChat/0.38.0',
  API_VERSION: '2025-04-01',
};

function normalizeBase(url: string): string {
  return url.replace(/\/$/, '');
}

export function openAIEndpoint(baseUrl: string | undefined, path: string): string {
  const base = normalizeBase(baseUrl ?? DEFAULT_BASE);
  if (/\/chat\/completions$/i.test(base)) {
    return path === 'chat/completions'
      ? base
      : base.replace(/\/chat\/completions$/i, `/${path}`);
  }
  if (/\/models$/i.test(base)) {
    return path === 'models'
      ? base
      : base.replace(/\/models$/i, `/${path}`);
  }
  if (/\/v\d+(?:\/[^/]*)?$/i.test(base) || /\/compatible-mode\/v\d+$/i.test(base)) {
    return `${base}/${path}`;
  }
  return `${base}/v1/${path}`;
}

function endpoint(base: string, path: string): string {
  return openAIEndpoint(base, path);
}

export function buildOpenAIHeaders(config: ProviderConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey ?? ''}`,
    ...config.extraHeaders,
  };
}

function isGithubCopilot(config: ProviderConfig): boolean {
  return !!(
    config.baseUrl?.toLowerCase().includes('api.githubcopilot.com') ||
    config.cookies?.oauth_provider === 'github'
  );
}

function expiresSoon(value: string | undefined): boolean {
  if (!value) return true;
  const timestamp = /^\d+$/.test(value)
    ? (Number(value) > 10_000_000_000 ? Number(value) : Number(value) * 1000)
    : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return true;
  return timestamp - Date.now() < 5 * 60 * 1000;
}

async function refreshGitHubCopilotToken(config: ProviderConfig, force = false): Promise<void> {
  if (!isGithubCopilot(config)) return;
  if (!force && config.apiKey && !expiresSoon(config.cookies?.copilot_token_expires_at)) return;

  let githubAccessToken = config.cookies?.github_access_token;
  const githubRefreshToken = config.cookies?.refresh_token || config.cookies?.github_refresh_token;
  let cookies = { ...(config.cookies ?? {}) };
  if (!githubAccessToken && githubRefreshToken) {
    const refreshed = await refreshGitHubOAuthToken(githubRefreshToken);
    if (refreshed?.accessToken) {
      githubAccessToken = refreshed.accessToken;
      cookies = {
        ...cookies,
        github_access_token: refreshed.accessToken,
        ...(refreshed.refreshToken ? { refresh_token: refreshed.refreshToken } : {}),
        ...(refreshed.expiresIn ? { github_access_token_expires_at: String(Date.now() + refreshed.expiresIn * 1000) } : {}),
      };
    }
  }
  if (!githubAccessToken) return;

  const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: {
      Authorization: `token ${githubAccessToken}`,
      'User-Agent': GITHUB_COPILOT.USER_AGENT,
      'Editor-Version': `vscode/${GITHUB_COPILOT.VSCODE_VERSION}`,
      'Editor-Plugin-Version': `copilot-chat/${GITHUB_COPILOT.COPILOT_CHAT_VERSION}`,
      Accept: 'application/json',
      'x-github-api-version': GITHUB_COPILOT.API_VERSION,
    },
  });
  if (!res.ok) return;
  const data = await res.json() as { token?: string; expires_at?: string };
  if (!data.token && githubRefreshToken) {
    const refreshed = await refreshGitHubOAuthToken(githubRefreshToken);
    if (refreshed?.accessToken && refreshed.accessToken !== githubAccessToken) {
      cookies = {
        ...cookies,
        github_access_token: refreshed.accessToken,
        ...(refreshed.refreshToken ? { refresh_token: refreshed.refreshToken } : {}),
        ...(refreshed.expiresIn ? { github_access_token_expires_at: String(Date.now() + refreshed.expiresIn * 1000) } : {}),
      };
      const retry = await fetch('https://api.github.com/copilot_internal/v2/token', {
        headers: {
          Authorization: `token ${refreshed.accessToken}`,
          'User-Agent': GITHUB_COPILOT.USER_AGENT,
          'Editor-Version': `vscode/${GITHUB_COPILOT.VSCODE_VERSION}`,
          'Editor-Plugin-Version': `copilot-chat/${GITHUB_COPILOT.COPILOT_CHAT_VERSION}`,
          Accept: 'application/json',
          'x-github-api-version': GITHUB_COPILOT.API_VERSION,
        },
      });
      if (!retry.ok) return;
      const retryData = await retry.json() as { token?: string; expires_at?: string };
      data.token = retryData.token;
      data.expires_at = retryData.expires_at;
    }
  }
  if (!data.token) return;

  config.apiKey = data.token;
  cookies = {
    ...cookies,
    ...(data.expires_at ? { copilot_token_expires_at: data.expires_at } : {}),
  };
  config.cookies = cookies;

  if (config.accountId) {
    db.prepare('UPDATE provider_accounts SET api_key = ?, cookies = ?, updated_at = ? WHERE id = ?')
      .run(data.token, JSON.stringify(cookies), Date.now(), config.accountId);
  } else {
    db.prepare('UPDATE providers SET api_key = ?, cookies = ?, updated_at = ? WHERE id = ?')
      .run(data.token, JSON.stringify(cookies), Date.now(), config.id);
  }
}

async function prepareOAuth(config: ProviderConfig, force = false): Promise<void> {
  await refreshOAuthToken(config, force);
  await refreshGitHubCopilotToken(config, force);
}

async function fetchWithAuthRetry(config: ProviderConfig, url: string, init: RequestInit): Promise<Response> {
  await prepareOAuth(config);
  let res = await fetch(url, { ...init, headers: buildOpenAIHeaders(config) });
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => {});
    await prepareOAuth(config, true);
    res = await fetch(url, { ...init, headers: buildOpenAIHeaders(config) });
  }
  return res;
}

async function refreshGitHubOAuthToken(refreshToken: string): Promise<{ accessToken?: string; refreshToken?: string; expiresIn?: number } | null> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: GITHUB_COPILOT.CLIENT_ID,
    }),
  });
  if (!res.ok) return null;
  const json = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token) return null;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || refreshToken,
    expiresIn: json.expires_in,
  };
}

export function supportsOpenAIJsonEndpoint(config: ProviderConfig): boolean {
  return ['openai', 'openai-compatible', 'ollama', 'gitlab'].includes(config.type);
}

export async function postOpenAIJson(config: ProviderConfig, path: string, body: unknown): Promise<{
  status: number;
  ok: boolean;
  data: unknown;
  text: string;
}> {
  const res = await fetchWithAuthRetry(config, openAIEndpoint(config.baseUrl, path), {
    method: 'POST',
    headers: buildOpenAIHeaders(config),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, data, text };
}

export async function postOpenAIBinary(config: ProviderConfig, path: string, body: unknown): Promise<{
  status: number;
  ok: boolean;
  contentType: string;
  data: Buffer;
  text: string;
}> {
  const res = await fetchWithAuthRetry(config, openAIEndpoint(config.baseUrl, path), {
    method: 'POST',
    headers: buildOpenAIHeaders(config),
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  const data = Buffer.from(await res.arrayBuffer());
  return { status: res.status, ok: res.ok, contentType, data, text: data.toString('utf8') };
}

function looksLikeHtml(text: string): boolean {
  const trimmed = text.trimStart().toLowerCase();
  return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html');
}

function webPageError(status: number, base: string): Error {
  const lowerBase = base.toLowerCase();
  const hint = lowerBase.includes('devin')
    ? ' Devin is not an OpenAI-compatible chat API; use Devin API endpoints under https://api.devin.ai or build a provider-specific Devin adapter.'
    : lowerBase.includes('qwen') || lowerBase.includes('dashscope')
    ? ' For Qwen, use a DashScope OpenAI-compatible base URL such as https://dashscope-intl.aliyuncs.com/compatible-mode/v1 or https://dashscope.aliyuncs.com/compatible-mode/v1.'
    : '';
  return new Error(
    `HTTP ${status}: ${base} is returning a web page, not an OpenAI-compatible API. Use the provider's API base URL, not the website URL.${hint}`
  );
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const out = value
      .map(item => stringValue(item)?.toLowerCase())
      .filter((item): item is string => !!item);
    return out.length ? Array.from(new Set(out)) : undefined;
  }
  const single = stringValue(value)?.toLowerCase();
  return single ? [single] : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = numberValue(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function modelContextLength(model: Record<string, unknown>): number | undefined {
  const topProvider = objectValue(model.top_provider);
  const limits = objectValue(model.limits);
  return firstNumber(
    model.context_length,
    model.contextLength,
    model.max_context_length,
    model.maxContextLength,
    model.max_context,
    model.maxContext,
    topProvider?.context_length,
    topProvider?.contextLength,
    limits?.context_length,
  );
}

function normalizePricePerMillion(value: unknown): number | undefined {
  const price = numberValue(value);
  if (price === undefined || price < 0) return undefined;
  return price < 0.001 ? price * 1_000_000 : price;
}

function modelPricing(model: Record<string, unknown>): { billing?: ModelInfo['billing']; summary?: string } {
  const pricing = objectValue(model.pricing) ?? objectValue(model.prices);
  if (!pricing) return {};

  const prompt = normalizePricePerMillion(pricing.prompt ?? pricing.input ?? pricing.input_tokens);
  const completion = normalizePricePerMillion(pricing.completion ?? pricing.output ?? pricing.output_tokens);
  const image = normalizePricePerMillion(pricing.image);
  const request = normalizePricePerMillion(pricing.request);
  const cacheRead = normalizePricePerMillion(pricing.input_cache_read ?? pricing.cache_read);
  const cacheWrite = normalizePricePerMillion(pricing.input_cache_write ?? pricing.cache_write);
  const prices = [prompt, completion, image, request, cacheRead, cacheWrite].filter((price): price is number => price !== undefined);
  const billing = prices.length ? (prices.some(price => price > 0) ? 'premium' : 'free') : undefined;

  const fmt = (price: number) => {
    if (price === 0) return '$0';
    if (price < 0.01) return `$${price.toFixed(4)}`;
    if (price < 1) return `$${price.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;
    return `$${price.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`;
  };
  const parts: string[] = [];
  if (prompt !== undefined) parts.push(`${fmt(prompt)} in`);
  if (completion !== undefined) parts.push(`${fmt(completion)} out`);
  if (image !== undefined && image > 0) parts.push(`${fmt(image)} image`);
  if (request !== undefined && request > 0) parts.push(`${fmt(request)} req`);
  const summary = parts.length ? `${parts.join(' / ')} perM tokens` : undefined;
  return { billing, summary };
}

function modelModalities(model: Record<string, unknown>): { input?: string[]; output?: string[] } {
  const architecture = objectValue(model.architecture);
  const input = stringArray(model.input_modalities)
    ?? stringArray(architecture?.input_modalities)
    ?? stringArray(model.inputs);
  const output = stringArray(model.output_modalities)
    ?? stringArray(architecture?.output_modalities)
    ?? stringArray(model.outputs);
  return { input, output };
}

function modelFeatures(model: Record<string, unknown>, input?: string[], output?: string[]): string[] | undefined {
  const id = stringValue(model.id)?.toLowerCase() ?? '';
  const supported = stringArray(model.supported_parameters) ?? [];
  const features = new Set<string>();
  if (id.includes('reason') || supported.some(item => item.includes('reasoning'))) features.add('reasoning');
  if (input?.includes('image')) features.add('vision');
  if (input?.includes('file')) features.add('files');
  if (output?.includes('image')) features.add('image-out');
  if (output?.includes('audio')) features.add('audio-out');
  if (supported.includes('tools') || supported.includes('tool_choice')) features.add('tools');
  if (supported.includes('response_format') || supported.includes('structured_outputs')) features.add('json');
  return features.size ? Array.from(features) : undefined;
}

function enrichOpenAIModel(model: Record<string, unknown>): Partial<ModelInfo> {
  const { billing, summary } = modelPricing(model);
  const { input, output } = modelModalities(model);
  return {
    context_length: modelContextLength(model),
    billing,
    pricing_summary: summary,
    input_modalities: input,
    output_modalities: output,
    features: modelFeatures(model, input, output),
  };
}

export const OpenAIAdapter: ProviderAdapter = {
  type: 'openai',

  async listModels(config) {
    const base = normalizeBase(config.baseUrl ?? DEFAULT_BASE);
    const url = endpoint(base, 'models');
    const res = await fetchWithAuthRetry(config, url, { headers: buildOpenAIHeaders(config) });
    const contentType = res.headers.get('content-type') ?? '';
    const text = await res.text().catch(() => res.statusText);
    if (!res.ok) {
      if (contentType.includes('text/html') || looksLikeHtml(text)) throw webPageError(res.status, base);
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (contentType.includes('text/html') || looksLikeHtml(text)) throw webPageError(res.status, base);

    let data: { data?: Record<string, unknown>[] };
    try {
      data = JSON.parse(text) as { data?: Record<string, unknown>[] };
    } catch {
      throw new Error(`HTTP ${res.status}: ${url} did not return valid JSON. Check that the provider base URL points to an OpenAI-compatible API endpoint.`);
    }
    const models: ModelInfo[] = [];
    for (const m of data.data ?? []) {
        const id = stringValue(m.id);
        if (!id) continue;
        const ownedBy = stringValue(m.owned_by ?? m.ownedBy ?? m.provider ?? m.author);
        models.push({
          id,
          name: stringValue(m.name) ?? id,
          capability: classifyModelCapability(id, ownedBy),
          owned_by: ownedBy,
          created: numberValue(m.created),
          ...enrichOpenAIModel(m),
        });
    }
    return models;
  },

  async complete(config, req) {
    const base = normalizeBase(config.baseUrl ?? DEFAULT_BASE);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.stop) body.stop = req.stop;

    const res = await fetchWithAuthRetry(config, endpoint(base, 'chat/completions'), {
      method: 'POST',
      headers: buildOpenAIHeaders(config),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${err}`);
    }

    const data = await res.json() as {
      id: string; model: string;
      choices: { message: { content: string }; finish_reason: string }[];
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    return {
      id: data.id,
      model: data.model,
      content: data.choices[0]?.message?.content ?? '',
      input_tokens: data.usage.prompt_tokens,
      output_tokens: data.usage.completion_tokens,
      finish_reason: data.choices[0]?.finish_reason ?? 'stop',
    };
  },

  async stream(config, req, onChunk) {
    const base = normalizeBase(config.baseUrl ?? DEFAULT_BASE);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.stop) body.stop = req.stop;

    const res = await fetchWithAuthRetry(config, endpoint(base, 'chat/completions'), {
      method: 'POST',
      headers: buildOpenAIHeaders(config),
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const err = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${err}`);
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
        if (raw === '[DONE]') {
          onChunk({ delta: '', done: true, input_tokens: inputTokens, output_tokens: outputTokens });
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
            inputTokens = evt.usage.prompt_tokens ?? 0;
            outputTokens = evt.usage.completion_tokens ?? 0;
          }

          if (evt.choices?.[0]?.finish_reason) {
            onChunk({ delta: '', done: true, input_tokens: inputTokens, output_tokens: outputTokens, finish_reason: evt.choices[0].finish_reason ?? undefined });
          }
        } catch {
          // ignore
        }
      }
    }
  },
};

export const OpenAICompatibleAdapter: ProviderAdapter = {
  ...OpenAIAdapter,
  type: 'openai-compatible',
};
