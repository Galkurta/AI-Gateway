import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db, getSetting, setSetting } from '../db/index.js';
import { hashApiKey } from '../middleware/auth.js';
import { logRequest } from '../middleware/logger.js';
import { fetchAllModels, resolveProvider, resolveByProvider } from '../providers/registry.js';
import type { NormalizedRequest } from '../providers/types.js';
import type { Provider, ProviderAccount, GatewayKey, RequestLog, ModelAlias } from '../db/index.js';
import { classifyModelCapability } from '../providers/capabilities.js';
import { postOpenAIBinary, postOpenAIJson, supportsOpenAIJsonEndpoint } from '../providers/adapters/openai.js';

export const adminRouter = Router();

function authTypeFromCredentials(apiKey?: string | null, cookies?: object | string | null): string {
  if (cookies) {
    try {
      const parsed = typeof cookies === 'string' ? JSON.parse(cookies) as Record<string, unknown> : cookies as Record<string, unknown>;
      if (typeof parsed.oauth_provider === 'string') return 'oauth';
    } catch {
      // fall through
    }
    return 'cookies';
  }
  return apiKey ? 'key' : 'none';
}

function maskAccount(a: ProviderAccount): Omit<ProviderAccount, 'api_key' | 'cookies'> & {
  api_key: string | null;
  cookies: string | null;
} {
  return {
    ...a,
    api_key: a.api_key ? `${a.api_key.slice(0, 8)}...` : null,
    cookies: a.cookies ? '[configured]' : null,
  };
}

/** Infer provider type from base URL when not explicitly specified */
function inferType(baseUrl: string): string {
  const u = baseUrl.toLowerCase();
  if (!u)                               return 'openai-compatible';
  if (u.includes('api.anthropic.com'))  return 'anthropic';
  if (u.includes('api.z.ai/api/anthropic') || u.includes('api.minimax.io/anthropic') || u.includes('api.minimaxi.com/anthropic') || u.includes('api.kimi.com/coding')) return 'anthropic-compatible';
  if (u.includes('bud.app'))            return 'bud-web';
  if (u.includes('app.devin.ai'))       return 'devin-web';
  if (u.includes('perplexity.ai') && !u.includes('api.perplexity.ai')) return 'perplexity-web';
  if (u.includes('zenmux.ai') && !u.includes('/api/')) return 'zenmux-web';
  if (u.includes('cloudcode-pa.googleapis.com')) return 'gemini-cli';
  if (u.includes('daily-cloudcode-pa.googleapis.com')) return 'antigravity';
  if (u.includes('backend-api/codex')) return 'codex';
  if (u.includes('codewhisperer')) return 'kiro';
  if (u.includes('api2.cursor.sh')) return 'cursor';
  if (u.includes('gitlab.com/api/v4')) return 'gitlab';
  if (u.includes('claude.ai'))          return 'claude-web';
  if (u.includes('chatgpt.com') || u.includes('chat.openai.com')) return 'chatgpt-web';
  if (u.includes('api.openai.com'))     return 'openai';
  if (u.includes('localhost:11434') || u.includes('ollama')) return 'ollama';
  return 'openai-compatible';
}

// ─── Stats / Dashboard ────────────────────────────────────────────────────────

adminRouter.get('/stats', (_req, res) => {
  const now = Date.now();
  const day = 86_400_000;

  const total = (db.prepare('SELECT COUNT(*) as c FROM request_logs').get() as { c: number }).c;
  const today = (db.prepare('SELECT COUNT(*) as c FROM request_logs WHERE created_at > ?').get(now - day) as { c: number }).c;
  const tokensTotal = (db.prepare('SELECT SUM(total_tokens) as t FROM request_logs').get() as { t: number | null }).t ?? 0;
  const tokensToday = (db.prepare('SELECT SUM(total_tokens) as t FROM request_logs WHERE created_at > ?').get(now - day) as { t: number | null }).t ?? 0;
  const errors = (db.prepare('SELECT COUNT(*) as c FROM request_logs WHERE status >= 400').get() as { c: number }).c;
  const activeProviders = (db.prepare('SELECT COUNT(*) as c FROM providers WHERE enabled = 1').get() as { c: number }).c;

  const perModel = db.prepare(`
    SELECT model, COUNT(*) as requests, SUM(total_tokens) as tokens
    FROM request_logs WHERE model IS NOT NULL GROUP BY model ORDER BY requests DESC LIMIT 10
  `).all() as { model: string; requests: number; tokens: number }[];

  const hourly = db.prepare(`
    SELECT
      (created_at / 3600000) * 3600000 as hour,
      COUNT(*) as requests,
      SUM(total_tokens) as tokens
    FROM request_logs
    WHERE created_at > ?
    GROUP BY hour ORDER BY hour
  `).all(now - day * 7) as { hour: number; requests: number; tokens: number }[];

  res.json({ total, today, tokensTotal, tokensToday, errors, activeProviders, perModel, hourly });
});

// ─── Providers ─────────────────────────────────────────────────────────────────

adminRouter.get('/providers', (_req, res) => {
  const providers = db.prepare('SELECT * FROM providers ORDER BY priority DESC, created_at ASC').all() as Provider[];
  const accountCounts = db.prepare(`
    SELECT provider_id, COUNT(*) as total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled
    FROM provider_accounts GROUP BY provider_id
  `).all() as { provider_id: string; total: number; enabled: number | null }[];
  const countsByProvider = new Map(accountCounts.map(c => [c.provider_id, c]));
  // Mask api_key partially
  res.json(providers.map(p => ({
    ...p,
    api_key: p.api_key ? `${p.api_key.slice(0, 8)}...` : null,
    cookies: p.cookies ? '[configured]' : null,
    account_count: countsByProvider.get(p.id)?.total ?? 0,
    enabled_account_count: countsByProvider.get(p.id)?.enabled ?? 0,
    auth_type: (() => {
      try {
        const parsed = p.cookies ? JSON.parse(p.cookies) as Record<string, unknown> : {};
        if (typeof parsed.oauth_provider === 'string') return 'oauth';
      } catch {
        // fall through
      }
      return p.cookies ? 'cookies' : (p.api_key ? 'key' : null);
    })(),
  })));
});

adminRouter.get('/providers/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id) as Provider | undefined;
  if (!p) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(p);
});

adminRouter.post('/providers', (req, res) => {
  const { name, base_url, api_key, cookies, extra_headers, notes, priority = 0 } = req.body as {
    name: string; base_url?: string; api_key?: string;
    cookies?: object; extra_headers?: object; notes?: string; priority?: number;
  };
  // type may be sent from frontend (already detected) or auto-detected here
  const type: string = (req.body as { type?: string }).type || inferType(base_url ?? '');

  if (!name) { res.status(400).json({ error: 'name is required' }); return; }

  const id = uuid();
  const now = Date.now();
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, api_key, cookies, extra_headers, notes, priority, enabled, created_at, updated_at)
    VALUES (@id, @name, @type, @base_url, @api_key, @cookies, @extra_headers, @notes, @priority, 1, @now, @now)
  `).run({
    id, name, type,
    base_url: base_url ?? null,
    api_key: api_key ?? null,
    cookies: cookies ? JSON.stringify(cookies) : null,
    extra_headers: extra_headers ? JSON.stringify(extra_headers) : null,
    notes: notes ?? null,
    priority,
    now,
  });
  res.status(201).json({ id });
});

adminRouter.put('/providers/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id) as Provider | undefined;
  if (!p) { res.status(404).json({ error: 'Not found' }); return; }

  const { name, type, base_url, api_key, cookies, extra_headers, notes, priority, enabled } = req.body as Partial<Provider & { cookies: object; extra_headers: object }>;
  db.prepare(`
    UPDATE providers SET
      name = @name, type = @type, base_url = @base_url, api_key = @api_key,
      cookies = @cookies, extra_headers = @extra_headers, notes = @notes,
      priority = @priority, enabled = @enabled, updated_at = @now
    WHERE id = @id
  `).run({
    id: req.params.id,
    name: name ?? p.name,
    type: type ?? p.type,
    base_url: base_url ?? p.base_url,
    api_key: api_key ?? p.api_key,
    cookies: cookies !== undefined ? (cookies ? JSON.stringify(cookies) : null) : p.cookies,
    extra_headers: extra_headers !== undefined ? (extra_headers ? JSON.stringify(extra_headers) : null) : p.extra_headers,
    notes: notes ?? p.notes,
    priority: priority ?? p.priority,
    enabled: enabled !== undefined ? (enabled ? 1 : 0) : p.enabled,
    now: Date.now(),
  });
  res.json({ ok: true });
});

adminRouter.delete('/providers/:id', (req, res) => {
  db.prepare('DELETE FROM providers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

adminRouter.get('/providers/:id/accounts', (req, res) => {
  const rows = db.prepare('SELECT * FROM provider_accounts WHERE provider_id = ? ORDER BY priority DESC, created_at ASC')
    .all(req.params.id) as ProviderAccount[];
  res.json(rows.map(maskAccount));
});

adminRouter.post('/providers/:id/accounts', (req, res) => {
  const provider = db.prepare('SELECT id FROM providers WHERE id = ?').get(req.params.id) as { id: string } | undefined;
  if (!provider) { res.status(404).json({ error: 'provider not found' }); return; }
  const { name, auth_type, api_key, cookies, extra_headers, priority = 0, enabled = true } = req.body as {
    name?: string; auth_type?: string; api_key?: string; cookies?: object; extra_headers?: object; priority?: number; enabled?: boolean;
  };
  const now = Date.now();
  const id = uuid();
  db.prepare(`
    INSERT INTO provider_accounts
      (id, provider_id, name, auth_type, api_key, cookies, extra_headers, enabled, priority, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    req.params.id,
    name?.trim() || 'Account',
    auth_type || authTypeFromCredentials(api_key, cookies),
    api_key || null,
    cookies ? JSON.stringify(cookies) : null,
    extra_headers ? JSON.stringify(extra_headers) : null,
    enabled ? 1 : 0,
    priority,
    now,
    now,
  );
  res.status(201).json({ id });
});

adminRouter.put('/providers/:providerId/accounts/:accountId', (req, res) => {
  const existing = db.prepare('SELECT * FROM provider_accounts WHERE id = ? AND provider_id = ?')
    .get(req.params.accountId, req.params.providerId) as ProviderAccount | undefined;
  if (!existing) { res.status(404).json({ error: 'account not found' }); return; }
  const { name, auth_type, api_key, cookies, extra_headers, priority, enabled, cooldown_until } = req.body as {
    name?: string; auth_type?: string; api_key?: string; cookies?: object | null; extra_headers?: object | null; priority?: number; enabled?: boolean; cooldown_until?: number | null;
  };
  const nextApiKey = api_key !== undefined ? (api_key || null) : existing.api_key;
  const nextCookies = cookies !== undefined ? (cookies ? JSON.stringify(cookies) : null) : existing.cookies;
  db.prepare(`
    UPDATE provider_accounts SET
      name = ?, auth_type = ?, api_key = ?, cookies = ?, extra_headers = ?,
      enabled = ?, priority = ?, cooldown_until = ?, updated_at = ?
    WHERE id = ? AND provider_id = ?
  `).run(
    name?.trim() || existing.name,
    auth_type || authTypeFromCredentials(nextApiKey, nextCookies),
    nextApiKey,
    nextCookies,
    extra_headers !== undefined ? (extra_headers ? JSON.stringify(extra_headers) : null) : existing.extra_headers,
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    priority ?? existing.priority,
    cooldown_until !== undefined ? cooldown_until : existing.cooldown_until,
    Date.now(),
    req.params.accountId,
    req.params.providerId,
  );
  res.json({ ok: true });
});

adminRouter.delete('/providers/:providerId/accounts/:accountId', (req, res) => {
  db.prepare('DELETE FROM provider_accounts WHERE id = ? AND provider_id = ?')
    .run(req.params.accountId, req.params.providerId);
  res.json({ ok: true });
});

// ─── Cookie update (from Chrome extension) ─────────────────────────────────────

adminRouter.post('/providers/:id/cookies', (req, res) => {
  const p = db.prepare('SELECT id, type, extra_headers FROM providers WHERE id = ?').get(req.params.id) as { id: string; type: string; extra_headers: string | null } | undefined;
  if (!p) { res.status(404).json({ error: 'Not found' }); return; }

  const { cookies } = req.body as { cookies: Record<string, string> };
  if (!cookies || typeof cookies !== 'object') { res.status(400).json({ error: 'cookies object required' }); return; }

  const extraHeaders = (() => {
    try {
      return p.extra_headers ? JSON.parse(p.extra_headers) as Record<string, string> : {};
    } catch {
      return {};
    }
  })();
  if (p.type === 'bud-web') {
    if (cookies.bud_projectid) extraHeaders['X-Bud-ProjectId'] = cookies.bud_projectid;
    if (cookies.bud_userid) extraHeaders['X-Bud-UserId'] = cookies.bud_userid;
    if (cookies.bud_chatsessionid) extraHeaders['X-Bud-ChatSessionId'] = cookies.bud_chatsessionid;
    if (cookies.bud_template) extraHeaders['X-Bud-Template'] = cookies.bud_template;
  }

  db.prepare('UPDATE providers SET cookies = ?, extra_headers = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(cookies), Object.keys(extraHeaders).length ? JSON.stringify(extraHeaders) : p.extra_headers, Date.now(), req.params.id);
  res.json({ ok: true, message: 'Cookies updated successfully' });
});

// ─── Model Routes ──────────────────────────────────────────────────────────────

adminRouter.get('/model-routes', (_req, res) => {
  const rows = db.prepare(`
    SELECT mr.*, p.name as provider_name FROM model_routes mr
    JOIN providers p ON p.id = mr.provider_id ORDER BY length(mr.pattern) DESC
  `).all();
  res.json(rows);
});

adminRouter.post('/model-routes', (req, res) => {
  const { pattern, provider_id, model_override } = req.body as { pattern: string; provider_id: string; model_override?: string };
  if (!pattern || !provider_id) { res.status(400).json({ error: 'pattern and provider_id required' }); return; }
  const id = uuid();
  db.prepare('INSERT INTO model_routes (id, pattern, provider_id, model_override, enabled) VALUES (?, ?, ?, ?, 1)')
    .run(id, pattern, provider_id, model_override ?? null);
  res.status(201).json({ id });
});

adminRouter.delete('/model-routes/:id', (req, res) => {
  db.prepare('DELETE FROM model_routes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Model aliases are client-visible model names mapped to one upstream provider/model.
adminRouter.get('/model-aliases', (_req, res) => {
  const rows = db.prepare(`
    SELECT ma.*, p.name as provider_name
    FROM model_aliases ma
    JOIN providers p ON p.id = ma.provider_id
    ORDER BY ma.alias ASC
  `).all();
  res.json(rows);
});

adminRouter.post('/model-aliases', (req, res) => {
  const { alias, provider_id, upstream_model, fork = false } = req.body as {
    alias?: string; provider_id?: string; upstream_model?: string; fork?: boolean;
  };
  const cleanAlias = alias?.trim();
  const cleanModel = upstream_model?.trim();
  if (!cleanAlias || !provider_id || !cleanModel) {
    res.status(400).json({ error: 'alias, provider_id, and upstream_model are required' });
    return;
  }
  const provider = db.prepare('SELECT id FROM providers WHERE id = ?').get(provider_id) as { id: string } | undefined;
  if (!provider) { res.status(404).json({ error: 'provider not found' }); return; }

  const now = Date.now();
  try {
    db.prepare(`
      INSERT INTO model_aliases (id, alias, provider_id, upstream_model, fork, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuid(), cleanAlias, provider_id, cleanModel, fork ? 1 : 0, now, now);
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

adminRouter.put('/model-aliases/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM model_aliases WHERE id = ?').get(req.params.id) as ModelAlias | undefined;
  if (!row) { res.status(404).json({ error: 'alias not found' }); return; }
  const { alias, provider_id, upstream_model, fork } = req.body as {
    alias?: string; provider_id?: string; upstream_model?: string; fork?: boolean;
  };
  const cleanAlias = typeof alias === 'string' ? alias.trim() : row.alias;
  const cleanModel = typeof upstream_model === 'string' ? upstream_model.trim() : row.upstream_model;
  if (!cleanAlias || !cleanModel) { res.status(400).json({ error: 'alias and upstream_model are required' }); return; }
  try {
    db.prepare(`
      UPDATE model_aliases SET alias = ?, provider_id = ?, upstream_model = ?, fork = ?, updated_at = ?
      WHERE id = ?
    `).run(cleanAlias, provider_id ?? row.provider_id, cleanModel, fork !== undefined ? (fork ? 1 : 0) : row.fork, Date.now(), req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

adminRouter.delete('/model-aliases/:id', (req, res) => {
  db.prepare('DELETE FROM model_aliases WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Settings ────────────────────────────────────────────────────────────────

adminRouter.get('/settings', (_req, res) => {
  const tokenSaver = getSetting('token_saver_enabled', process.env.TOKEN_SAVER ?? 'false');
  res.json({
    token_saver_enabled: tokenSaver === '1' || tokenSaver.toLowerCase() === 'true',
  });
});

adminRouter.put('/settings', (req, res) => {
  const body = req.body as { token_saver_enabled?: boolean };
  if (body.token_saver_enabled !== undefined) {
    setSetting('token_saver_enabled', body.token_saver_enabled ? 'true' : 'false');
  }
  res.json({ ok: true });
});

// ─── Gateway Keys ─────────────────────────────────────────────────────────────

adminRouter.get('/keys', (_req, res) => {
  const keys = db.prepare('SELECT * FROM gateway_keys ORDER BY created_at DESC').all() as GatewayKey[];
  res.json(keys.map(k => ({ ...k, key_hash: undefined })));
});

adminRouter.post('/keys', (req, res) => {
  const { name } = req.body as { name?: string };
  const rawKey = `sk-gw-${uuid().replace(/-/g, '')}`;
  const hash = hashApiKey(rawKey);
  const preview = `${rawKey.slice(0, 12)}...${rawKey.slice(-4)}`;
  const id = uuid();
  db.prepare('INSERT INTO gateway_keys (id, key_hash, key_preview, name, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run(id, hash, preview, name ?? null, Date.now());
  // Return the raw key ONCE - it won't be shown again
  res.status(201).json({ id, key: rawKey, preview, name });
});

adminRouter.delete('/keys/:id', (req, res) => {
  db.prepare('DELETE FROM gateway_keys WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

adminRouter.patch('/keys/:id', (req, res) => {
  const { enabled, name } = req.body as { enabled?: boolean; name?: string };
  if (enabled !== undefined) db.prepare('UPDATE gateway_keys SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, req.params.id);
  if (name !== undefined) db.prepare('UPDATE gateway_keys SET name = ? WHERE id = ?').run(name, req.params.id);
  res.json({ ok: true });
});

// ─── Request Logs ─────────────────────────────────────────────────────────────

adminRouter.get('/logs', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, parseInt(req.query.limit as string) || 50);
  const offset = (page - 1) * limit;
  const model = req.query.model as string | undefined;
  const provider = req.query.provider as string | undefined;
  const status = req.query.status as string | undefined;

  let where = 'WHERE 1=1';
  const params: (string | number)[] = [];
  if (model) { where += ' AND model = ?'; params.push(model); }
  if (provider) { where += ' AND provider_id = ?'; params.push(provider); }
  if (status === 'error') { where += ' AND status >= 400'; }
  else if (status === 'ok') { where += ' AND status < 400'; }

  const total = (db.prepare(`SELECT COUNT(*) as c FROM request_logs ${where}`).get(...params) as { c: number }).c;
  const logs = db.prepare(`SELECT * FROM request_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as RequestLog[];

  res.json({ logs, total, page, limit, pages: Math.ceil(total / limit) });
});

adminRouter.delete('/logs', (_req, res) => {
  db.prepare('DELETE FROM request_logs').run();
  res.json({ ok: true });
});

// ─── Available Models ─────────────────────────────────────────────────────────

adminRouter.get('/models', async (_req, res) => {
  try {
    const result = await fetchAllModels();
    res.json(result); // { models: [...], errors: [...] }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

adminRouter.post('/models/test', async (req, res) => {
  const startedAt = Date.now();
  const requestId = `modeltest-${uuid().replace(/-/g, '').slice(0, 24)}`;
  const { model, prompt, provider_id } = req.body as { model?: string; prompt?: string; provider_id?: string };
  if (!model) { res.status(400).json({ error: 'model is required' }); return; }

  // If provider_id is supplied, route directly — no fallback to other providers.
  const resolved = provider_id ? resolveByProvider(provider_id, model) : resolveProvider(model);
  if (!resolved) { res.status(404).json({ error: `No provider found for model: ${model}` }); return; }

  const { adapter, config, resolvedModel } = resolved;
  const capability = classifyModelCapability(resolvedModel);
  if (capability !== 'chat' && !supportsOpenAIJsonEndpoint(config)) {
    const error = `${config.type} adapter is chat-only for dashboard tests. ${capability} models require an OpenAI-compatible provider endpoint.`;
    logRequest({
      id: requestId,
      provider_id: config.id,
      model: resolvedModel,
      endpoint: 'models.test',
      status: 400,
      latency: Date.now() - startedAt,
      error,
      req_body: { model, prompt, provider_id },
    });
    res.json({
      ok: false,
      model,
      resolvedModel,
      capability,
      provider: { id: config.id, name: config.name, type: config.type },
      latency: Date.now() - startedAt,
      error,
    });
    return;
  }

  try {
    if (capability === 'embedding') {
      const requestBody = {
        model: resolvedModel,
        input: prompt || 'OK',
      };
      const upstream = await postOpenAIJson(config, 'embeddings', {
        ...requestBody,
      });
      if (!upstream.ok) throw new Error(`OpenAI-compatible embeddings error ${upstream.status}: ${upstream.text}`);
      const data = upstream.data as { data?: { embedding?: unknown[] }[]; usage?: { prompt_tokens?: number; total_tokens?: number } };
      const dimensions = Array.isArray(data.data?.[0]?.embedding) ? data.data?.[0]?.embedding?.length ?? 0 : 0;
      const usage = {
        input_tokens: data.usage?.prompt_tokens ?? data.usage?.total_tokens ?? 0,
        output_tokens: 0,
        total_tokens: data.usage?.total_tokens ?? data.usage?.prompt_tokens ?? 0,
      };
      const responseBody = {
        ok: true,
        model,
        resolvedModel,
        capability,
        provider: { id: config.id, name: config.name, type: config.type },
        latency: Date.now() - startedAt,
        content: `Embedding OK${dimensions ? ` (${dimensions} dimensions)` : ''}`,
        usage,
      };
      logRequest({
        id: requestId,
        provider_id: config.id,
        model: resolvedModel,
        endpoint: 'models.test.embeddings',
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        status: 200,
        latency: Date.now() - startedAt,
        req_body: requestBody,
        res_body: responseBody,
      });
      res.json(responseBody);
      return;
    }

    if (capability === 'image') {
      const requestBody = {
        model: resolvedModel,
        prompt: prompt || 'A minimal test image with the text OK',
        n: 1,
      };
      const upstream = await postOpenAIJson(config, 'images/generations', requestBody);
      if (!upstream.ok) throw new Error(`OpenAI-compatible image generation error ${upstream.status}: ${upstream.text}`);
      const data = upstream.data as { data?: unknown[] };
      const responseBody = {
        ok: true,
        model,
        resolvedModel,
        capability,
        provider: { id: config.id, name: config.name, type: config.type },
        latency: Date.now() - startedAt,
        content: `Image generation OK (${data.data?.length ?? 0} result${(data.data?.length ?? 0) === 1 ? '' : 's'})`,
      };
      logRequest({
        id: requestId,
        provider_id: config.id,
        model: resolvedModel,
        endpoint: 'models.test.images',
        status: 200,
        latency: Date.now() - startedAt,
        req_body: requestBody,
        res_body: responseBody,
      });
      res.json(responseBody);
      return;
    }

    if (capability === 'tts') {
      const requestBody = {
        model: resolvedModel,
        input: prompt || 'OK',
        voice: 'alloy',
      };
      const upstream = await postOpenAIBinary(config, 'audio/speech', requestBody);
      if (!upstream.ok) throw new Error(`OpenAI-compatible audio speech error ${upstream.status}: ${upstream.text}`);
      const responseBody = {
        ok: true,
        model,
        resolvedModel,
        capability,
        provider: { id: config.id, name: config.name, type: config.type },
        latency: Date.now() - startedAt,
        content: `TTS OK (${upstream.data.length} bytes, ${upstream.contentType})`,
      };
      logRequest({
        id: requestId,
        provider_id: config.id,
        model: resolvedModel,
        endpoint: 'models.test.audio.speech',
        status: 200,
        latency: Date.now() - startedAt,
        req_body: requestBody,
        res_body: responseBody,
      });
      res.json(responseBody);
      return;
    }

    if (capability !== 'chat') {
      const error = `${capability} model test is classified correctly, but this gateway does not have a standardized test request for that endpoint yet.`;
      logRequest({
        id: requestId,
        provider_id: config.id,
        model: resolvedModel,
        endpoint: 'models.test',
        status: 400,
        latency: Date.now() - startedAt,
        error,
        req_body: { model, prompt, provider_id },
      });
      res.json({
        ok: false,
        model,
        resolvedModel,
        capability,
        provider: { id: config.id, name: config.name, type: config.type },
        latency: Date.now() - startedAt,
        error,
      });
      return;
    }

    const requestBody: NormalizedRequest = {
      model: resolvedModel,
      messages: [{ role: 'user', content: prompt || 'Reply with a short OK if this model is working.' }],
      max_tokens: 128,
      temperature: 0.2,
    };
    const result = await adapter.complete(config, requestBody);
    const responseBody = {
      ok: true,
      model,
      resolvedModel,
      capability,
      provider: { id: config.id, name: config.name, type: config.type },
      latency: Date.now() - startedAt,
      content: result.content,
      usage: {
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
        total_tokens: result.input_tokens + result.output_tokens,
      },
    };
    logRequest({
      id: requestId,
      provider_id: config.id,
      model: resolvedModel,
      endpoint: 'models.test.chat',
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      status: 200,
      latency: Date.now() - startedAt,
      req_body: requestBody,
      res_body: { content: result.content.slice(0, 500) },
    });
    res.json(responseBody);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const responseBody = {
      ok: false,
      model,
      resolvedModel,
      capability,
      provider: { id: config.id, name: config.name, type: config.type },
      latency: Date.now() - startedAt,
      error,
    };
    logRequest({
      id: requestId,
      provider_id: config.id,
      model: resolvedModel,
      endpoint: `models.test.${capability}`,
      status: 500,
      latency: Date.now() - startedAt,
      error,
      req_body: { model, prompt, provider_id },
      res_body: responseBody,
    });
    res.status(200).json(responseBody);
  }
});
