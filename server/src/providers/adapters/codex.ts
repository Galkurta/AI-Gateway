import { randomUUID } from 'node:crypto';
import type { ChatMessage, ModelInfo, NormalizedRequest, ProviderAdapter, ProviderConfig } from '../types.js';
import { refreshOAuthToken } from '../oauth-refresh.js';

const CODEX_MODELS: ModelInfo[] = [
  { id: 'gpt-5.3-codex', name: 'GPT 5.3 Codex', owned_by: 'openai' },
  { id: 'gpt-5.3-codex-high', name: 'GPT 5.3 Codex High', owned_by: 'openai' },
  { id: 'gpt-5.2-codex', name: 'GPT 5.2 Codex', owned_by: 'openai' },
  { id: 'gpt-5.1-codex', name: 'GPT 5.1 Codex', owned_by: 'openai' },
  { id: 'gpt-5-codex', name: 'GPT 5 Codex', owned_by: 'openai' },
];

function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.map(part => part.type === 'text' ? part.text ?? '' : part.image_url?.url ?? '').filter(Boolean).join('\n');
}

function toResponsesInput(messages: ChatMessage[]): object[] {
  return messages.map(msg => ({
    type: 'message',
    role: msg.role,
    content: [{ type: msg.role === 'assistant' ? 'output_text' : 'input_text', text: textOf(msg.content) }],
  })).filter(item => (item as { content: { text: string }[] }).content[0]?.text);
}

function bearer(config: ProviderConfig): string {
  return config.apiKey ?? config.cookies?.access_token ?? config.cookies?.oauth_access_token ?? '';
}

function buildHeaders(config: ProviderConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${bearer(config)}`,
    originator: 'codex-cli',
    'User-Agent': 'codex-cli/1.0.18',
    session_id: config.id,
    ...config.extraHeaders,
  };
}

async function fetchWithAuthRetry(config: ProviderConfig, url: string, body: object): Promise<Response> {
  await refreshOAuthToken(config);
  let res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => {});
    await refreshOAuthToken(config, true);
    res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify(body),
    });
  }
  return res;
}

function stripEffort(model: string): { model: string; effort: string } {
  for (const effort of ['xhigh', 'high', 'medium', 'low', 'none']) {
    if (model.endsWith(`-${effort}`)) return { model: model.slice(0, -effort.length - 1), effort };
  }
  return { model, effort: 'low' };
}

function parseSse(text: string): string {
  let out = '';
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const evt = JSON.parse(raw) as Record<string, unknown>;
      if (typeof evt.delta === 'string') out += evt.delta;
      if (typeof evt.text === 'string') out += evt.text;
      if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') out += evt.delta;
      const response = evt.response as Record<string, unknown> | undefined;
      if (response && typeof response.output_text === 'string') out = response.output_text;
    } catch {}
  }
  return out;
}

export const CodexAdapter: ProviderAdapter = {
  type: 'codex',
  async listModels() {
    return CODEX_MODELS;
  },
  async complete(config, req) {
    const base = (config.baseUrl ?? 'https://chatgpt.com/backend-api/codex/responses').replace(/\/$/, '');
    const { model, effort } = stripEffort(req.model);
    const body = {
      model,
      input: toResponsesInput(req.messages),
      stream: true,
      store: false,
      reasoning: { effort, summary: 'auto' },
      include: effort !== 'none' ? ['reasoning.encrypted_content'] : undefined,
      instructions: 'You are Codex, a concise coding assistant.',
    };
    const res = await fetchWithAuthRetry(config, base, body);
    const text = await res.text();
    if (!res.ok) throw new Error(`Codex error ${res.status}: ${text.slice(0, 500)}`);
    return {
      id: `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      model,
      content: parseSse(text),
      input_tokens: 0,
      output_tokens: 0,
      finish_reason: 'stop',
    };
  },
  async stream(config, req, onChunk) {
    const result = await this.complete(config, { ...req, stream: false });
    onChunk({ delta: result.content, done: false });
    onChunk({ delta: '', done: true, input_tokens: result.input_tokens, output_tokens: result.output_tokens, finish_reason: result.finish_reason });
  },
};
