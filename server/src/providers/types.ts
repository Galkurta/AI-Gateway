export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'openai-compatible'
  | 'anthropic-compatible'
  | 'claude-web'
  | 'chatgpt-web'
  | 'bud-web'
  | 'devin-web'
  | 'perplexity-web'
  | 'zenmux-web'
  | 'gemini-cli'
  | 'antigravity'
  | 'codex'
  | 'kiro'
  | 'cursor'
  | 'gitlab'
  | 'ollama';

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  accountId?: string;
  accountName?: string;
  baseUrl?: string;
  apiKey?: string;
  cookies?: Record<string, string>;
  extraHeaders?: Record<string, string>;
}

// --- Normalized internal formats ---

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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  [key: string]: unknown;
}

export interface ContentPart {
  type: 'text' | 'image_url' | 'tool_result';
  text?: string;
  content?: string | ContentPart[];
  is_error?: boolean;
  image_url?: { url: string; detail?: string };
  [key: string]: unknown;
}

export interface NormalizedRequest {
  model: string;
  messages: ChatMessage[];
  system?: string;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  [key: string]: unknown;
}

export interface NormalizedResponse {
  id: string;
  model: string;
  content: string;
  input_tokens: number;
  output_tokens: number;
  finish_reason: string;
}

export interface StreamChunk {
  delta: string;
  done: boolean;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  finish_reason?: string;
}

export interface ProviderAdapter {
  readonly type: ProviderType;

  /** List available models for this provider */
  listModels(config: ProviderConfig): Promise<ModelInfo[]>;

  /** Non-streaming completion */
  complete(config: ProviderConfig, req: NormalizedRequest): Promise<NormalizedResponse>;

  /** Streaming completion - yields SSE chunks */
  stream(
    config: ProviderConfig,
    req: NormalizedRequest,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<void>;
}

export interface ModelInfo {
  id: string;
  name: string;
  capability?: ModelCapability;
  context_length?: number;
  owned_by?: string;
  created?: number;
  billing?: 'free' | 'premium' | 'unknown';
  pricing_summary?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  features?: string[];
  source_id?: string;
  alias_of?: string;
  forked_alias?: boolean;
}
