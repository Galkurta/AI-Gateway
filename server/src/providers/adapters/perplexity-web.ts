/**
 * Perplexity Web adapter.
 * Uses browser session cookies from perplexity.ai to bypass API key requirement.
 * Reverse-engineered from perplexity.ai network traffic.
 *
 * Key cookies needed: __Secure-next-auth.session-token, __cf_bm, cf_clearance
 * Extract via the Chrome extension while logged in to perplexity.ai.
 *
 * Perplexity returns cumulative full-text in each SSE chunk (not deltas),
 * so we compute deltas by tracking the previous text length.
 */
import type {
  ProviderAdapter, ProviderConfig, NormalizedRequest,
  NormalizedResponse, ModelInfo,
} from '../types.js';

const BASE_URL = 'https://www.perplexity.ai';

const PERPLEXITY_MODELS: ModelInfo[] = [
  { id: 'perplexity-auto',                   name: 'Auto (Perplexity)',                          owned_by: 'perplexity' },
  { id: 'sonar',                             name: 'Sonar (Perplexity)',                         owned_by: 'perplexity' },
  { id: 'sonar-pro',                         name: 'Sonar Pro (Perplexity)',                     owned_by: 'perplexity' },
  { id: 'sonar-reasoning',                   name: 'Sonar Reasoning (Perplexity)',               owned_by: 'perplexity' },
  { id: 'sonar-reasoning-pro',               name: 'Sonar Reasoning Pro (Perplexity)',           owned_by: 'perplexity' },
  { id: 'sonar-deep-research',               name: 'Sonar Deep Research (Perplexity)',           owned_by: 'perplexity' },
  { id: 'perplexity-claude-sonnet',          name: 'Claude Sonnet 4.6 via Perplexity',          owned_by: 'perplexity' },
  { id: 'perplexity-claude-sonnet-thinking', name: 'Claude Sonnet 4.6 Thinking via Perplexity', owned_by: 'perplexity' },
  { id: 'perplexity-gpt54',                  name: 'GPT-5.4 via Perplexity',                    owned_by: 'perplexity' },
  { id: 'perplexity-gemini31pro',            name: 'Gemini 3.1 Pro via Perplexity',             owned_by: 'perplexity' },
  { id: 'perplexity-kimi26',                 name: 'Kimi K2.6 via Perplexity',                  owned_by: 'perplexity' },
  { id: 'perplexity-kimi26-thinking',        name: 'Kimi K2.6 Thinking via Perplexity',         owned_by: 'perplexity' },
  { id: 'perplexity-nemotron',               name: 'Nemotron 3 Super via Perplexity',           owned_by: 'perplexity' },
];

function cookieHeader(config: ProviderConfig): string {
  return Object.entries(config.cookies ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function buildHeaders(config: ProviderConfig): Record<string, string> {
  return {
    'Content-Type':   'application/json',
    'Accept':         'text/event-stream',
    'Cookie':         cookieHeader(config),
    'Origin':         BASE_URL,
    'Referer':        `${BASE_URL}/`,
    'User-Agent':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'x-client-name':    'perplexity-web',
    'x-client-version': '1.0',
    ...config.extraHeaders,
  };
}

function contentToText(content: NormalizedRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter(p => p.type === 'text' && typeof p.text === 'string')
    .map(p => p.text as string)
    .join('\n');
}

function buildQuery(req: NormalizedRequest): string {
  // Build a single query string from the conversation.
  // If there's a system prompt, prepend it.
  const parts: string[] = [];
  if (req.system) parts.push(req.system);
  for (const m of req.messages) {
    if (m.role === 'system') continue;
    const text = contentToText(m.content).trim();
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

type PerplexityMarkdownBlock = {
  progress?: string;
  chunks?: string[];
  answer?: string;
};

type PerplexityBlock = {
  intended_usage: string;
  markdown_block?: PerplexityMarkdownBlock;
};

type PerplexityMessage = {
  final_sse_message?: boolean;
  blocks?: PerplexityBlock[];
};

/**
 * Extract answer text from a Perplexity SSE data line.
 *
 * Each SSE event is a flat JSON object. Text accumulates in:
 *   blocks[].markdown_block.chunks (streaming) / .answer (final)
 * where intended_usage is 'ask_text' or 'ask_text_0_markdown'.
 * final_sse_message: true marks the stream end.
 */
function extractChunkText(raw: string): { text: string; final: boolean } | null {
  if (raw === '[DONE]') return { text: '', final: true };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const msg = parsed as PerplexityMessage;
  const isFinal = msg.final_sse_message === true;

  // Find the answer block — prefer 'ask_text' (plain text) over markdown variant
  const block = msg.blocks?.find(b => b.intended_usage === 'ask_text' && b.markdown_block)
    ?? msg.blocks?.find(b => b.intended_usage?.startsWith('ask_text') && b.markdown_block);

  if (block?.markdown_block) {
    const mb = block.markdown_block;
    // Use answer (final) or reconstruct from chunks (streaming)
    const text = mb.answer ?? (mb.chunks?.join('') ?? '');
    if (text || isFinal) return { text, final: isFinal };
  }

  if (isFinal) return { text: '', final: true };
  return null;
}

export const PerplexityWebAdapter: ProviderAdapter = {
  type: 'perplexity-web',

  async listModels(): Promise<ModelInfo[]> {
    return PERPLEXITY_MODELS;
  },

  async complete(config, req): Promise<NormalizedResponse> {
    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;
    await this.stream(config, req, chunk => {
      if (!chunk.done) content += chunk.delta;
      if (chunk.input_tokens)  inputTokens  = chunk.input_tokens;
      if (chunk.output_tokens) outputTokens = chunk.output_tokens;
    });
    return {
      id: `perplexity-web-${Date.now()}`,
      model: req.model,
      content,
      input_tokens:  inputTokens  || estimateTokens(buildQuery(req)),
      output_tokens: outputTokens || estimateTokens(content),
      finish_reason: 'stop',
    };
  },

  async stream(config, req, onChunk): Promise<void> {
    const cookies = cookieHeader(config);
    if (!cookies) {
      throw new Error(
        'Perplexity Web requires cookies from a logged-in perplexity.ai session. ' +
        'Extract them with the Chrome extension while on perplexity.ai.'
      );
    }

    const query = buildQuery(req);
    if (!query.trim()) throw new Error('No message content to send.');

    // [mode, model_preference] — mode 'concise'=free, 'copilot'=Pro
    const modelMap: Record<string, [string, string]> = {
      'perplexity-auto':                   ['concise', 'turbo'],
      'sonar':                             ['concise', 'experimental'],
      'sonar-pro':                         ['copilot', 'pplx_pro'],
      'sonar-reasoning':                   ['copilot', 'pplx_reasoning'],
      'sonar-reasoning-pro':               ['copilot', 'pplx_reasoning'],
      'sonar-deep-research':               ['copilot', 'pplx_alpha'],
      'perplexity-claude-sonnet':          ['copilot', 'claude46sonnet'],
      'perplexity-claude-sonnet-thinking': ['copilot', 'claude46sonnetthinking'],
      'perplexity-gpt54':                  ['copilot', 'gpt54'],
      'perplexity-gemini31pro':            ['copilot', 'gemini31pro'],
      'perplexity-kimi26':                 ['copilot', 'kimik26'],
      'perplexity-kimi26-thinking':        ['copilot', 'kimik26thinking'],
      'perplexity-nemotron':               ['copilot', 'nemotron3super'],
    };
    const [internalMode, modelPreference] = modelMap[req.model] ?? ['concise', 'turbo'];

    const body: Record<string, unknown> = {
      query_str:        query,
      mode:             internalMode,
      search_focus:     'internet',
      attachments:      [],
      language:         'en-US',
      timezone:         'UTC',
      is_incognito:     false,
      model_preference: modelPreference,
    };

    const res = await fetch(`${BASE_URL}/rest/sse/perplexity_ask`, {
      method:  'POST',
      headers: buildHeaders(config),
      body:    JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => res.statusText);
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Perplexity session expired or invalid (${res.status}). ` +
          'Re-extract cookies from perplexity.ai via the Chrome extension.'
        );
      }
      throw new Error(`Perplexity Web error ${res.status}: ${text.slice(0, 300)}`);
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer       = '';
    let emittedText  = '';
    let finalEmitted = false;

    const processLine = (line: string) => {
      if (!line.startsWith('data:')) return;
      const raw = line.slice(5).trim();
      if (!raw) return;

      const result = extractChunkText(raw);
      if (!result) return;

      const { text, final } = result;

      if (text && text !== emittedText) {
        // Perplexity may send full text (not delta) — emit only the new portion
        const delta = text.startsWith(emittedText)
          ? text.slice(emittedText.length)
          : text;
        emittedText += delta;
        if (delta) onChunk({ delta, done: false });
      }

      if (final && !finalEmitted) {
        finalEmitted = true;
        onChunk({
          delta:         '',
          done:          true,
          input_tokens:  estimateTokens(query),
          output_tokens: estimateTokens(emittedText),
          finish_reason: 'stop',
        });
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

    // Flush any remaining partial line
    if (buffer.trim()) processLine(buffer);

    if (!finalEmitted) {
      onChunk({
        delta:         '',
        done:          true,
        input_tokens:  estimateTokens(query),
        output_tokens: estimateTokens(emittedText),
        finish_reason: 'stop',
      });
    }
  },
};
