import { db, getSetting, setSetting } from '../db/index.js';
import type { Provider, ModelAlias, ProviderAccount } from '../db/index.js';
import type { ProviderAdapter, ProviderConfig, ProviderType, NormalizedRequest, ModelInfo } from './types.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { OpenAIAdapter, OpenAICompatibleAdapter } from './adapters/openai.js';
import { ClaudeWebAdapter } from './adapters/claude-web.js';
import { ChatGPTWebAdapter } from './adapters/chatgpt-web.js';
import { BudWebAdapter } from './adapters/bud-web.js';
import { DevinWebAdapter } from './adapters/devin-web.js';
import { PerplexityWebAdapter } from './adapters/perplexity-web.js';
import { ZenMuxWebAdapter } from './adapters/zenmux-web.js';
import { GeminiCliAdapter, AntigravityAdapter } from './adapters/cloudcode.js';
import { CodexAdapter } from './adapters/codex.js';
import { CursorAdapter, KiroAdapter } from './adapters/not-ported.js';
import { classifyModelCapability } from './capabilities.js';

const ADAPTERS: Record<ProviderType, ProviderAdapter> = {
  'anthropic': AnthropicAdapter,
  'anthropic-compatible': { ...AnthropicAdapter, type: 'anthropic-compatible' },
  'openai': OpenAIAdapter,
  'openai-compatible': OpenAICompatibleAdapter,
  'ollama': { ...OpenAICompatibleAdapter, type: 'ollama' },
  'claude-web': ClaudeWebAdapter,
  'chatgpt-web': ChatGPTWebAdapter,
  'bud-web': BudWebAdapter,
  'devin-web': DevinWebAdapter,
  'perplexity-web': PerplexityWebAdapter,
  'zenmux-web': ZenMuxWebAdapter,
  'gemini-cli': GeminiCliAdapter,
  'antigravity': AntigravityAdapter,
  'codex': CodexAdapter,
  'kiro': KiroAdapter,
  'cursor': CursorAdapter,
  'gitlab': { ...OpenAICompatibleAdapter, type: 'gitlab' },
};

// Default base URLs per type
const DEFAULT_BASE_URLS: Partial<Record<ProviderType, string>> = {
  'anthropic': 'https://api.anthropic.com',
  'openai': 'https://api.openai.com',
  'gemini-cli': 'https://cloudcode-pa.googleapis.com/v1internal',
  'antigravity': 'https://daily-cloudcode-pa.googleapis.com',
  'codex': 'https://chatgpt.com/backend-api/codex/responses',
  'zenmux-web': 'https://zenmux.ai',
  'gitlab': 'https://gitlab.com/api/v4',
  'ollama': 'http://localhost:11434',
};

function effectiveProviderType(p: Pick<Provider, 'type' | 'base_url'>): ProviderType {
  const base = p.base_url?.toLowerCase() ?? '';
  if (base.includes('backend-api/codex')) return 'codex';
  if (base.includes('app.devin.ai')) return 'devin-web';
  if (base.includes('bud.app')) return 'bud-web';
  if (base.includes('perplexity.ai') && !base.includes('api.perplexity.ai')) return 'perplexity-web';
  if (base.includes('zenmux.ai') && !base.includes('/api/')) return 'zenmux-web';
  if (base.includes('claude.ai')) return 'claude-web';
  if (base.includes('chatgpt.com') || base.includes('chat.openai.com')) return 'chatgpt-web';
  return p.type as ProviderType;
}

function pickRoundRobin<T extends { id: string }>(items: T[], key: string): T | undefined {
  if (!items.length) return undefined;
  if (items.length === 1) return items[0];
  const settingKey = `rr:${key}`;
  const current = Number.parseInt(getSetting(settingKey, '0'), 10);
  const index = Number.isFinite(current) ? current % items.length : 0;
  setSetting(settingKey, String(index + 1));
  return items[index];
}

function parseJsonObject(value: string | null | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as Record<string, string>;
  } catch {
    return undefined;
  }
}

function pickProviderAccount(provider: Provider): ProviderAccount | undefined {
  const now = Date.now();
  const total = (db.prepare('SELECT COUNT(*) as c FROM provider_accounts WHERE provider_id = ?')
    .get(provider.id) as { c: number }).c;
  if (total === 0) return undefined;
  const accounts = db.prepare(`
    SELECT * FROM provider_accounts
    WHERE provider_id = ?
      AND enabled = 1
      AND (cooldown_until IS NULL OR cooldown_until <= ?)
    ORDER BY priority DESC, created_at ASC
  `).all(provider.id, now) as ProviderAccount[];
  const selected = pickRoundRobin(accounts, `account:${provider.id}:${accounts.map(a => a.id).join(',')}`);
  if (selected) {
    db.prepare('UPDATE provider_accounts SET requests_count = requests_count + 1, last_used_at = ? WHERE id = ?')
      .run(now, selected.id);
  }
  return selected ?? {
    id: '',
    provider_id: provider.id,
    name: 'No active account',
    auth_type: 'none',
    api_key: null,
    cookies: null,
    extra_headers: null,
    enabled: 0,
    priority: 0,
    requests_count: 0,
    error_count: 0,
    last_used_at: null,
    last_error_at: null,
    cooldown_until: null,
    created_at: 0,
    updated_at: 0,
  };
}

export function getAdapter(type: ProviderType): ProviderAdapter {
  return ADAPTERS[type] ?? OpenAICompatibleAdapter;
}

export function dbProviderToConfig(p: Provider): ProviderConfig {
  const type = effectiveProviderType(p);
  const account = pickProviderAccount(p);
  const providerHeaders = parseJsonObject(p.extra_headers) ?? {};
  const accountHeaders = parseJsonObject(account?.extra_headers) ?? {};
  return {
    id: p.id,
    name: p.name,
    type,
    accountId: account?.id,
    accountName: account?.name,
    baseUrl: p.base_url ?? DEFAULT_BASE_URLS[type],
    apiKey: account?.api_key ?? p.api_key ?? undefined,
    cookies: parseJsonObject(account?.cookies ?? p.cookies),
    extraHeaders: Object.keys({ ...providerHeaders, ...accountHeaders }).length ? { ...providerHeaders, ...accountHeaders } : undefined,
  };
}

/** Resolve directly to a specific provider by ID, bypassing all routing heuristics.
 *  If `model` is an alias on this provider, resolves to the upstream model automatically. */
export function resolveByProvider(providerId: string, model: string): ReturnType<typeof resolveProvider> {
  const p = db.prepare('SELECT * FROM providers WHERE id = ? AND enabled = 1').get(providerId) as Provider | undefined;
  if (!p) return null;
  const config = dbProviderToConfig(p);

  // Resolve alias → upstream model (alias is provider-scoped in the UI but globally unique in DB)
  const alias = db.prepare(
    'SELECT upstream_model FROM model_aliases WHERE provider_id = ? AND alias = ?'
  ).get(providerId, model) as { upstream_model: string } | undefined;

  const resolvedModel = alias?.upstream_model ?? model;
  return { adapter: getAdapter(config.type), config, resolvedModel };
}

/** Find the best provider+adapter for a given model name */
export function resolveProvider(model: string): {
  adapter: ProviderAdapter;
  config: ProviderConfig;
  resolvedModel: string;
} | null {
  // 0. Exact client-visible model aliases.
  const aliasMatches = db.prepare(`
    SELECT ma.*, p.* FROM model_aliases ma
    JOIN providers p ON p.id = ma.provider_id
    WHERE ma.alias = ? AND p.enabled = 1
    ORDER BY p.priority DESC, ma.created_at ASC
  `).all(model) as (Provider & ModelAlias)[];

  if (aliasMatches.length) {
    const alias = pickRoundRobin(aliasMatches, `alias:${model}:${aliasMatches.map(a => a.id).join(',')}`) ?? aliasMatches[0];
    const config = dbProviderToConfig(alias);
    return { adapter: getAdapter(config.type), config, resolvedModel: alias.upstream_model };
  }

  // 1. Check explicit model routes first (by pattern matching)
  const routes = db.prepare(
    `SELECT mr.*, p.* FROM model_routes mr
     JOIN providers p ON p.id = mr.provider_id
     WHERE mr.enabled = 1 AND p.enabled = 1
     ORDER BY length(mr.pattern) DESC`
  ).all() as (Provider & { pattern: string; model_override: string | null })[];

  const matchingRoutes: (Provider & { pattern: string; model_override: string | null })[] = [];
  for (const route of routes) {
    const pat = route.pattern;
    const matches =
      pat === model ||
      pat === '*' ||
      (pat.endsWith('*') && model.startsWith(pat.slice(0, -1))) ||
      (pat.startsWith('*') && model.endsWith(pat.slice(1)));

    if (matches) matchingRoutes.push(route);
  }

  if (matchingRoutes.length) {
    const route = pickRoundRobin(matchingRoutes, `route:${model}:${matchingRoutes.map(r => r.id).join(',')}`) ?? matchingRoutes[0];
    const config = dbProviderToConfig(route);
    const adapter = getAdapter(config.type);
    return { adapter, config, resolvedModel: route.model_override ?? model };
  }

  // 2. Auto-detect by model name prefix from enabled providers
  const autoDetect = autoDetectProvider(model);
  if (autoDetect) return autoDetect;

  // 3. Fall back to highest-priority enabled provider
  const fallbackProviders = db.prepare(
    'SELECT * FROM providers WHERE enabled = 1 ORDER BY priority DESC, created_at ASC'
  ).all() as Provider[];
  const fallback = pickRoundRobin(fallbackProviders, 'fallback');

  if (fallback) {
    const config = dbProviderToConfig(fallback);
    return {
      adapter: getAdapter(config.type),
      config,
      resolvedModel: model,
    };
  }

  return null;
}

function autoDetectProvider(model: string): ReturnType<typeof resolveProvider> {
  const providers = db.prepare(
    'SELECT * FROM providers WHERE enabled = 1 ORDER BY priority DESC'
  ).all() as Provider[];

  // Match by model prefix conventions.
  // Bud-exclusive model names: gpt-5.x and claude-opus-4.6 are only served by Bud.
  // 'auto' routes to Bud only when no other specific match is found.
  // claude-sonnet-4-6 is intentionally NOT in this list — it's a real Anthropic model too.
  const BUD_EXCLUSIVE = new Set(['auto', 'claude-opus-4.6', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex']);
  const isBudWeb = BUD_EXCLUSIVE.has(model);
  const isPerplexityWeb = model === 'perplexity-auto' || model.startsWith('sonar') || model.startsWith('perplexity-');
  const isAnthropic = model.startsWith('claude');
  const isOpenAI = model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4');
  const isXAI = model.startsWith('grok');
  const isDevin = model.startsWith('devin-');
  const isCodex = model.includes('codex');
  const isGemini = model.startsWith('gemini');
  const isKiro = model.startsWith('kiro');
  const isCursor = model.startsWith('cursor');

  if (isPerplexityWeb) {
    const p = pickRoundRobin(providers.filter(p => effectiveProviderType(p) === 'perplexity-web'), 'auto:perplexity');
    if (p) {
      const config = dbProviderToConfig(p);
      return { adapter: getAdapter('perplexity-web'), config, resolvedModel: model };
    }
  }

  if (isCursor) {
    const p = pickRoundRobin(providers.filter(p => p.type === 'cursor'), 'auto:cursor');
    if (p) return { adapter: getAdapter('cursor'), config: dbProviderToConfig(p), resolvedModel: model };
  }

  if (isKiro) {
    const p = pickRoundRobin(providers.filter(p => p.type === 'kiro'), 'auto:kiro');
    if (p) return { adapter: getAdapter('kiro'), config: dbProviderToConfig(p), resolvedModel: model };
  }

  if (isCodex) {
    const p = pickRoundRobin(providers.filter(p => p.type === 'codex'), 'auto:codex');
    if (p) return { adapter: getAdapter('codex'), config: dbProviderToConfig(p), resolvedModel: model };
  }

  if (isGemini) {
    const p = pickRoundRobin(providers.filter(p => p.type === 'antigravity' || p.type === 'gemini-cli'), 'auto:gemini');
    if (p) return { adapter: getAdapter(p.type as ProviderType), config: dbProviderToConfig(p), resolvedModel: model };
  }

  if (isDevin) {
    const p = pickRoundRobin(providers.filter(p => effectiveProviderType(p) === 'devin-web'), 'auto:devin');
    if (p) {
      const config = dbProviderToConfig(p);
      return {
        adapter: getAdapter(config.type),
        config,
        resolvedModel: model,
      };
    }
  }

  if (isBudWeb) {
    const p = pickRoundRobin(providers.filter(p => p.type === 'bud-web'), 'auto:bud');
    if (p) {
      return {
        adapter: getAdapter(p.type as ProviderType),
        config: dbProviderToConfig(p),
        resolvedModel: model,
      };
    }
  }

  if (isXAI) {
    const p = pickRoundRobin(providers.filter(p =>
      p.base_url?.toLowerCase().includes('api.x.ai') ||
      p.name.toLowerCase() === 'x' ||
      p.name.toLowerCase().includes('xai')
    ), 'auto:xai');
    if (p) {
      return {
        adapter: getAdapter(p.type as ProviderType),
        config: dbProviderToConfig(p),
        resolvedModel: model,
      };
    }
  }

  const matched = providers.filter(p =>
      (isAnthropic && (p.type === 'anthropic' || p.type === 'anthropic-compatible' || p.type === 'claude-web')) ||
      (isOpenAI && (p.type === 'openai' || p.type === 'openai-compatible' || p.type === 'chatgpt-web' || p.type === 'bud-web'))
  );

  const p = pickRoundRobin(matched, `auto:${isAnthropic ? 'anthropic' : 'openai'}`);
  if (p) {
    return {
      adapter: getAdapter(p.type as ProviderType),
      config: dbProviderToConfig(p),
      resolvedModel: model,
    };
  }
  return null;
}

export type FetchModelsResult = {
  models: (ModelInfo & { provider_id: string; provider_name: string })[];
  errors: { provider_id: string; provider_name: string; error: string }[];
};

export async function fetchAllModels(): Promise<FetchModelsResult> {
  const providers = db.prepare('SELECT * FROM providers WHERE enabled = 1').all() as Provider[];
  const aliases = db.prepare('SELECT * FROM model_aliases').all() as ModelAlias[];
  const providersById = new Map(providers.map(p => [p.id, p]));
  const aliasesByModel = new Map<string, ModelAlias[]>();
  for (const alias of aliases) {
    const key = `${alias.provider_id}:${alias.upstream_model}`;
    const list = aliasesByModel.get(key) ?? [];
    list.push(alias);
    aliasesByModel.set(key, list);
  }

  const models: FetchModelsResult['models'] = [];
  const errors: FetchModelsResult['errors'] = [];
  const fetchedUpstreams = new Set<string>();

  await Promise.allSettled(
    providers.map(async (p) => {
      try {
        const config = dbProviderToConfig(p);
        const adapter = getAdapter(config.type);
        const fetched = await adapter.listModels(config);
        for (const m of fetched) {
          fetchedUpstreams.add(`${p.id}:${m.id}`);
          const matchingAliases = aliasesByModel.get(`${p.id}:${m.id}`) ?? [];
          const replacingAliases = matchingAliases.filter(a => !a.fork);
          const forkedAliases = matchingAliases.filter(a => !!a.fork);

          if (replacingAliases.length) {
            for (const alias of replacingAliases) {
              models.push({
                ...m,
                id: alias.alias,
                name: alias.alias,
                capability: m.capability ?? classifyModelCapability(alias.alias, m.owned_by),
                source_id: m.id,
                alias_of: m.id,
                provider_id: p.id,
                provider_name: p.name,
              });
            }
          } else {
            models.push({ ...m, capability: m.capability ?? classifyModelCapability(m.id, m.owned_by), source_id: m.id, provider_id: p.id, provider_name: p.name });
          }

          for (const alias of forkedAliases) {
            models.push({
              ...m,
              id: alias.alias,
              name: alias.alias,
              capability: m.capability ?? classifyModelCapability(alias.alias, m.owned_by),
              source_id: m.id,
              alias_of: m.id,
              forked_alias: true,
              provider_id: p.id,
              provider_name: p.name,
            });
          }
        }
      } catch (err) {
        errors.push({
          provider_id: p.id,
          provider_name: p.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );

  for (const alias of aliases) {
    if (fetchedUpstreams.has(`${alias.provider_id}:${alias.upstream_model}`)) continue;
    const p = providersById.get(alias.provider_id);
    if (!p) continue;
    models.push({
      id: alias.alias,
      name: alias.alias,
      owned_by: 'manual',
      capability: classifyModelCapability(alias.alias),
      source_id: alias.upstream_model,
      alias_of: alias.alias === alias.upstream_model ? undefined : alias.upstream_model,
      forked_alias: !!alias.fork,
      provider_id: p.id,
      provider_name: p.name,
    });
  }

  return { models, errors };
}
