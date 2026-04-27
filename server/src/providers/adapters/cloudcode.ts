import { randomUUID } from 'node:crypto';
import type { ChatMessage, ModelInfo, NormalizedRequest, ProviderAdapter, ProviderConfig } from '../types.js';
import { refreshOAuthToken } from '../oauth-refresh.js';

const GEMINI_MODELS: ModelInfo[] = [
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro', owned_by: 'google' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', owned_by: 'google' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', owned_by: 'google' },
];

const ANTIGRAVITY_MODELS: ModelInfo[] = [
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro', owned_by: 'google' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', owned_by: 'anthropic' },
  { id: 'claude-opus-4.6', name: 'Claude Opus 4.6', owned_by: 'anthropic' },
];

function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.map(part => part.type === 'text' ? part.text ?? '' : part.image_url?.url ?? '').filter(Boolean).join('\n');
}

function toGeminiContents(messages: ChatMessage[]): { systemInstruction?: object; contents: object[] } {
  const systemParts: { text: string }[] = [];
  const contents: object[] = [];

  for (const msg of messages) {
    const text = textOf(msg.content);
    if (!text) continue;
    if (msg.role === 'system') {
      systemParts.push({ text });
      continue;
    }
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text }],
    });
  }

  return {
    systemInstruction: systemParts.length ? { role: 'user', parts: systemParts } : undefined,
    contents,
  };
}

function cookies(config: ProviderConfig): Record<string, string> {
  return config.cookies ?? {};
}

function bearer(config: ProviderConfig): string {
  return config.apiKey ?? cookies(config).access_token ?? cookies(config).oauth_access_token ?? '';
}

function buildHeaders(config: ProviderConfig, antigravity: boolean): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${bearer(config)}`,
    'User-Agent': antigravity ? 'antigravity/1.107.0' : 'gemini-cli/0.12.0',
    ...(antigravity ? { 'x-request-source': 'local' } : { 'X-Goog-Api-Client': 'gl-node/22.0.0' }),
    ...config.extraHeaders,
  };
}

async function fetchWithAuthRetry(config: ProviderConfig, url: string, antigravity: boolean, body: object): Promise<Response> {
  await refreshOAuthToken(config);
  let res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(config, antigravity),
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => {});
    await refreshOAuthToken(config, true);
    res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(config, antigravity),
      body: JSON.stringify(body),
    });
  }
  return res;
}

function projectId(config: ProviderConfig): string {
  return cookies(config).project_id ?? `ai-gateway-${randomUUID().slice(0, 8)}`;
}

function buildBody(config: ProviderConfig, req: NormalizedRequest, antigravity: boolean, stream: boolean): object {
  const converted = toGeminiContents(req.messages);
  return {
    project: projectId(config),
    model: req.model,
    userAgent: antigravity ? 'antigravity' : 'gemini-cli',
    requestId: antigravity ? `agent-${randomUUID()}` : `ai-gateway-${randomUUID()}`,
    ...(antigravity ? { requestType: 'agent' } : {}),
    request: {
      sessionId: `sess-${config.id}-${Date.now()}`,
      contents: converted.contents.length ? converted.contents : [{ role: 'user', parts: [{ text: 'Hello' }] }],
      systemInstruction: converted.systemInstruction,
      generationConfig: {
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.top_p !== undefined ? { topP: req.top_p } : {}),
        ...(req.max_tokens !== undefined ? { maxOutputTokens: req.max_tokens } : {}),
      },
      ...(antigravity ? {} : { safetySettings: [] }),
    },
  };
}

function extractText(data: Record<string, unknown>): string {
  const response = (data.response && typeof data.response === 'object') ? data.response as Record<string, unknown> : data;
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  const first = candidates[0] as Record<string, unknown> | undefined;
  const content = first?.content as Record<string, unknown> | undefined;
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  return parts.map(part => {
    const p = part as Record<string, unknown>;
    return typeof p.text === 'string' ? p.text : '';
  }).join('');
}

function usage(data: Record<string, unknown>): { input: number; output: number } {
  const response = (data.response && typeof data.response === 'object') ? data.response as Record<string, unknown> : data;
  const meta = response.usageMetadata as Record<string, unknown> | undefined;
  return {
    input: typeof meta?.promptTokenCount === 'number' ? meta.promptTokenCount : 0,
    output: typeof meta?.candidatesTokenCount === 'number' ? meta.candidatesTokenCount : 0,
  };
}

function makeAdapter(kind: 'gemini-cli' | 'antigravity'): ProviderAdapter {
  const antigravity = kind === 'antigravity';
  const defaultBase = antigravity ? 'https://daily-cloudcode-pa.googleapis.com' : 'https://cloudcode-pa.googleapis.com/v1internal';
  return {
    type: kind,
    async listModels() {
      return antigravity ? ANTIGRAVITY_MODELS : GEMINI_MODELS;
    },
    async complete(config, req) {
      const base = (config.baseUrl ?? defaultBase).replace(/\/$/, '');
      const url = antigravity ? `${base}/v1internal:generateContent` : `${base}:generateContent`;
      const res = await fetchWithAuthRetry(config, url, antigravity, buildBody(config, req, antigravity, false));
      const text = await res.text();
      if (!res.ok) throw new Error(`${kind} error ${res.status}: ${text.slice(0, 500)}`);
      const data = JSON.parse(text) as Record<string, unknown>;
      const u = usage(data);
      return {
        id: `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        model: req.model,
        content: extractText(data),
        input_tokens: u.input,
        output_tokens: u.output,
        finish_reason: 'stop',
      };
    },
    async stream(config, req, onChunk) {
      const result = await this.complete(config, { ...req, stream: false });
      onChunk({ delta: result.content, done: false });
      onChunk({ delta: '', done: true, input_tokens: result.input_tokens, output_tokens: result.output_tokens, finish_reason: result.finish_reason });
    },
  };
}

export const GeminiCliAdapter = makeAdapter('gemini-cli');
export const AntigravityAdapter = makeAdapter('antigravity');
