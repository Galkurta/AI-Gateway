import { createHash, randomUUID } from 'node:crypto';
import { db } from '../../db/index.js';
import type {
  ModelInfo,
  NormalizedRequest,
  NormalizedResponse,
  ProviderAdapter,
  ProviderConfig,
} from '../types.js';
import { refreshOAuthToken } from '../oauth-refresh.js';

const BASE_URL = 'https://app.devin.ai';

const DEVIN_MODELS: ModelInfo[] = [
  { id: 'devin-2-5', name: 'Devin 2.5', owned_by: 'cognition' },
  { id: 'devin-opus-4-7', name: 'Devin Opus 4.7', owned_by: 'cognition' },
  { id: 'devin-0929-brocade', name: 'Devin Brocade', owned_by: 'cognition' },
];

function baseUrl(config: ProviderConfig): string {
  return (config.baseUrl ?? BASE_URL).replace(/\/$/, '');
}

function cookieHeader(config: ProviderConfig): string {
  return Object.entries(config.cookies ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function jwtFromText(value: string): string | undefined {
  const match = value.match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (!match) return undefined;
  try {
    const [, payload] = match[0].split('.');
    JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return match[0];
  } catch {
    return undefined;
  }
}

function auth1Token(config: ProviderConfig): string | undefined {
  const explicit = config.cookies?.__devin_auth1_token ?? config.cookies?.devin_auth1_token;
  if (explicit) return explicit;

  const raw = config.cookies?.storage_auth1_session;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed.token === 'string' && parsed.token ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

function storedContext(config: ProviderConfig): { orgId?: string; userId?: string; orgName?: string } {
  const fromSettings = {
    orgId: setting(config, 'OrgId'),
    userId: setting(config, 'UserId'),
    orgName: setting(config, 'OrgName'),
  };
  if (fromSettings.orgId || fromSettings.userId) return fromSettings;

  let userId: string | undefined;
  try {
    const auth = config.cookies?.storage_auth1_session
      ? JSON.parse(config.cookies.storage_auth1_session) as { userId?: unknown }
      : null;
    if (typeof auth?.userId === 'string') userId = auth.userId;
  } catch {}

  for (const [key, value] of Object.entries(config.cookies ?? {})) {
    if (!key.includes('post-auth')) continue;
    try {
      const parsed = JSON.parse(value) as {
        internalOrgId?: unknown;
        orgName?: unknown;
        userId?: unknown;
        result?: { org_id?: unknown; org_name?: unknown };
      };
      const orgId = typeof parsed.internalOrgId === 'string'
        ? parsed.internalOrgId
        : typeof parsed.result?.org_id === 'string'
          ? parsed.result.org_id
          : undefined;
      if (orgId) {
        return {
          orgId,
          userId: typeof parsed.userId === 'string' ? parsed.userId : userId,
          orgName: typeof parsed.orgName === 'string'
            ? parsed.orgName
            : typeof parsed.result?.org_name === 'string'
              ? parsed.result.org_name
              : undefined,
        };
      }
    } catch {}
  }

  return { userId };
}

function findBearer(config: ProviderConfig): string | undefined {
  const explicit = setting(config, 'Bearer')
    ?? setting(config, 'AccessToken')
    ?? config.cookies?.__devin_bearer
    ?? config.cookies?.devin_bearer
    ?? auth1Token(config);
  if (explicit) return explicit.replace(/^Bearer\s+/i, '');

  for (const [key, value] of Object.entries(config.cookies ?? {})) {
    const lower = key.toLowerCase();
    if (!lower.includes('auth') && !lower.includes('token') && !lower.includes('session')) continue;
    const token = jwtFromText(value);
    if (token) return token;
  }
  return undefined;
}

function devinTokenSource(config: ProviderConfig): string | undefined {
  return config.cookies?.__devin_token_source ?? config.cookies?.devin_token_source;
}

function headers(config: ProviderConfig): Record<string, string> {
  const cookies = cookieHeader(config);
  const bearer = findBearer(config);
  const context = storedContext(config);
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': BASE_URL,
    'Referer': `${BASE_URL}/`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    ...(cookies ? { Cookie: cookies } : {}),
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    ...(context.orgId ? {
      'x-cog-org-id': context.orgId,
      'X-Org-Id': context.orgId,
      'X-Organization-Id': context.orgId,
      'X-Devin-Org-Id': context.orgId,
    } : {}),
  };
}

function setting(config: ProviderConfig, key: string): string | undefined {
  const headers = config.extraHeaders ?? {};
  const cookies = config.cookies ?? {};
  return headers[key]
    ?? headers[key.toLowerCase()]
    ?? headers[`X-Devin-${key}`]
    ?? headers[`x-devin-${key.toLowerCase()}`]
    ?? cookies[key]
    ?? cookies[key.toLowerCase()]
    ?? cookies[`devin_${key.toLowerCase()}`];
}

function contentToText(content: NormalizedRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n');
}

function userMessages(req: NormalizedRequest): string[] {
  return req.messages
    .filter(m => m.role === 'user')
    .map(m => contentToText(m.content).trim())
    .filter(Boolean);
}

function promptFromRequest(req: NormalizedRequest): string {
  const prompt = userMessages(req).at(-1) ?? '';
  if (!prompt) throw new Error('Devin Web requires at least one user text message.');
  return prompt;
}

function requestText(req: NormalizedRequest): string {
  const messages = req.messages
    .map(message => `${message.role}: ${contentToText(message.content)}`)
    .join('\n');
  return req.system ? `system: ${req.system}\n${messages}` : messages;
}

function estimateTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Devin returned non-JSON response ${res.status}: ${text.slice(0, 200)}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function metadata(req: NormalizedRequest): Record<string, unknown> {
  return isObject(req.metadata) ? req.metadata : {};
}

function explicitSessionId(req: NormalizedRequest): string | undefined {
  const meta = metadata(req);
  return stringFromUnknown(req.devin_session_id)
    ?? stringFromUnknown(meta.devin_session_id)
    ?? stringFromUnknown(meta.devinSessionId)
    ?? stringFromUnknown(meta.session_id)
    ?? stringFromUnknown(meta.sessionId);
}

function conversationKey(req: NormalizedRequest): string {
  const meta = metadata(req);
  const explicit = stringFromUnknown(req.conversation_id)
    ?? stringFromUnknown(req.thread_id)
    ?? stringFromUnknown(req.chat_id)
    ?? stringFromUnknown(meta.conversation_id)
    ?? stringFromUnknown(meta.conversationId)
    ?? stringFromUnknown(meta.thread_id)
    ?? stringFromUnknown(meta.threadId)
    ?? stringFromUnknown(meta.chat_id)
    ?? stringFromUnknown(meta.chatId);
  const firstUser = userMessages(req)[0] ?? requestText(req);
  const seed = explicit ? `explicit:${explicit}` : `first-user:${firstUser}`;
  return createHash('sha256').update(`${req.model}\n${seed}`).digest('hex').slice(0, 32);
}

function sessionMap(config: ProviderConfig): Record<string, string> {
  const raw = config.cookies?.devin_session_map;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.startsWith('devin-')) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function savedSessionId(config: ProviderConfig, req: NormalizedRequest): string | undefined {
  return explicitSessionId(req) ?? sessionMap(config)[conversationKey(req)];
}

function saveSessionId(config: ProviderConfig, req: NormalizedRequest, devinId: string): void {
  const map = sessionMap(config);
  map[conversationKey(req)] = devinId;
  const entries = Object.entries(map).slice(-100);
  const cookies = {
    ...(config.cookies ?? {}),
    devin_session_map: JSON.stringify(Object.fromEntries(entries)),
    devin_last_session_id: devinId,
  };
  config.cookies = cookies;
  const now = Date.now();
  if (config.accountId) {
    db.prepare('UPDATE provider_accounts SET cookies = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(cookies), now, config.accountId);
  } else {
    db.prepare('UPDATE providers SET cookies = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(cookies), now, config.id);
  }
}

async function createSession(config: ProviderConfig, req: NormalizedRequest): Promise<string> {
  const prompt = promptFromRequest(req);
  const devinId = `devin-${randomUUID().replace(/-/g, '')}`;
  const model = req.model || setting(config, 'VersionOverride') || 'devin-2-5';
  const username = setting(config, 'Username') ?? 'User';
  const plannerType = setting(config, 'PlannerType') ?? 'fast';
  const planningMode = setting(config, 'PlanningMode') ?? 'automatic';
  const context = storedContext(config);

  const body = {
    devin_id: devinId,
    user_message: prompt,
    username,
    ...(context.orgId ? { org_id: context.orgId, organization_id: context.orgId } : {}),
    ...(context.userId ? { user_id: context.userId } : {}),
    rich_content: [{ text: prompt }],
    repos: [],
    snapshot_id: null,
    tags: [],
    from_spaces: 'false',
    planner_type: plannerType,
    planning_mode: planningMode,
    bypass_approval: false,
    'devin-rs': 'true',
    devin_version_override: model,
    additional_args: {
      planning_mode: planningMode,
      planner_type: plannerType,
      from_spaces: 'false',
      bypass_approval: false,
      'devin-rs': 'true',
      devin_version_override: model,
    },
  };

  let res = await fetch(`${baseUrl(config)}/api/sessions`, {
    method: 'POST',
    headers: headers(config),
    body: JSON.stringify(body),
  });
  if (res.status === 401 && await refreshOAuthToken(config, true).catch(() => false)) {
    res = await fetch(`${baseUrl(config)}/api/sessions`, {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify(body),
    });
  }
  const json = await readJson(res);
  if (res.status === 401) {
    const hasBearer = !!findBearer(config);
    throw new Error(
      hasBearer
        ? `Devin session create failed 401 even with a stored bearer token: ${JSON.stringify(json)}`
        : `Devin session create failed 401: ${JSON.stringify(json)}. Re-extract Devin cookies with the updated extension while logged in to app.devin.ai; Devin auth appears to require a browser storage bearer token, not just cookies.`
    );
  }
  if (!res.ok) throw new Error(`Devin session create failed ${res.status}: ${JSON.stringify(json)}`);
  if (isObject(json) && typeof json.devin_id === 'string') return json.devin_id;
  return devinId;
}

async function sendMessageToSession(config: ProviderConfig, devinId: string, req: NormalizedRequest): Promise<boolean> {
  const prompt = promptFromRequest(req);
  const context = storedContext(config);
  const userId = context.userId ?? setting(config, 'UserId');
  const orgId = context.orgId ?? setting(config, 'OrgId');

  if (userId && orgId) {
    let res = await fetch(`${baseUrl(config)}/api/resume-devin`, {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify({
        user_id: userId,
        org_id: orgId,
        devin_id: devinId,
        reason: prompt,
      }),
    });
    if (res.status === 401 && await refreshOAuthToken(config, true).catch(() => false)) {
      res = await fetch(`${baseUrl(config)}/api/resume-devin`, {
        method: 'POST',
        headers: headers(config),
        body: JSON.stringify({
          user_id: userId,
          org_id: orgId,
          devin_id: devinId,
          reason: prompt,
        }),
      });
    }
    if (res.ok) return true;
  }

  const attempts = [
    `${baseUrl(config)}/api/sessions/${encodeURIComponent(devinId)}/message`,
    `${baseUrl(config)}/api/session/${encodeURIComponent(devinId)}/message`,
  ];
  for (const url of attempts) {
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify({ message: prompt }),
    });
    if (res.ok) return true;
  }
  return false;
}

async function resolveOrgId(config: ProviderConfig, devinId: string): Promise<string> {
  const configured = setting(config, 'OrgId');
  if (configured) return configured;
  const stored = storedContext(config).orgId;
  if (stored) return stored;

  const res = await fetch(`${baseUrl(config)}/api/users/post-auth`, {
    method: 'POST',
    headers: headers(config),
    body: JSON.stringify({ devin_id: devinId }),
  });
  const json = await readJson(res);
  if (!res.ok) throw new Error(`Devin post-auth failed ${res.status}: ${JSON.stringify(json)}`);
  if (isObject(json) && typeof json.org_id === 'string') return json.org_id;
  throw new Error('Devin Web requires org_id. Capture it from /api/users/post-auth or set X-Devin-OrgId in provider extra headers.');
}

function sessionMessage(session: Record<string, unknown>): string | null {
  const contents = session.latest_message_contents;
  if (!isObject(contents)) return null;
  if (contents.type !== 'devin_message') return null;
  return typeof contents.message === 'string' && contents.message.trim() ? contents.message : null;
}

async function fetchSession(config: ProviderConfig, orgId: string, devinId: string, startedAt: number): Promise<Record<string, unknown> | null> {
  const params = new URLSearchParams({
    include_pinned: 'true',
    group_children: 'true',
    limit: '30',
    order_by: 'updated_at',
    sort_direction: 'desc',
    is_archived: 'false',
    session_type: 'devin',
    updated_date_from: new Date(startedAt - 60_000).toISOString(),
  });
  const userId = setting(config, 'UserId');
  if (userId) params.set('creators', userId);

  let res = await fetch(`${baseUrl(config)}/api/${encodeURIComponent(orgId)}/v2sessions?${params}`, {
    headers: headers(config),
  });
  if (res.status === 401 && await refreshOAuthToken(config, true).catch(() => false)) {
    res = await fetch(`${baseUrl(config)}/api/${encodeURIComponent(orgId)}/v2sessions?${params}`, {
      headers: headers(config),
    });
  }
  const json = await readJson(res);
  if (res.status === 401) {
    const source = devinTokenSource(config) ?? 'unknown';
    throw new Error(
      `Devin v2sessions failed 401: ${JSON.stringify(json)}. ` +
      `Bearer source=${source}. Re-extract Devin with the updated extension after app.devin.ai fully loads; ` +
      `this endpoint requires the runtime access token from __HACK__getAccessToken, not only auth1_session/cookies.`
    );
  }
  if (!res.ok) throw new Error(`Devin v2sessions failed ${res.status}: ${JSON.stringify(json)}`);
  const result = isObject(json) && Array.isArray(json.result) ? json.result : [];
  return result.find(item => isObject(item) && item.devin_id === devinId) as Record<string, unknown> | undefined ?? null;
}

async function waitForMessage(config: ProviderConfig, orgId: string, devinId: string, startedAt: number): Promise<string> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const session = await fetchSession(config, orgId, devinId, startedAt);
    if (session) {
      const message = sessionMessage(session);
      if (message) return message;

      const status = isObject(session.latest_status_contents) ? session.latest_status_contents.enum : undefined;
      if ((status === 'failed' || status === 'errored') && !message) {
        throw new Error(`Devin session ended with status ${String(status)} before returning a message.`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Timed out waiting for Devin to return a devin_message in v2sessions.');
}

async function runDevin(config: ProviderConfig, req: NormalizedRequest): Promise<{ content: string; devinId: string }> {
  await refreshOAuthToken(config).catch(() => false);
  if (!cookieHeader(config) && !findBearer(config)) {
    throw new Error('Devin Web requires cookies or a bearer token from a logged-in app.devin.ai session.');
  }
  const startedAt = Date.now();
  const existingDevinId = savedSessionId(config, req);
  const shouldResume = !!existingDevinId && userMessages(req).length > 1;
  let devinId = existingDevinId ?? '';
  if (shouldResume) {
    const sent = await sendMessageToSession(config, existingDevinId, req);
    if (!sent) {
      devinId = await createSession(config, req);
      saveSessionId(config, req, devinId);
    }
  } else {
    devinId = await createSession(config, req);
    saveSessionId(config, req, devinId);
  }
  const orgId = await resolveOrgId(config, devinId);
  const content = await waitForMessage(config, orgId, devinId, startedAt);
  return { content, devinId };
}

export const DevinWebAdapter: ProviderAdapter = {
  type: 'devin-web',

  async listModels(): Promise<ModelInfo[]> {
    return DEVIN_MODELS;
  },

  async complete(config, req): Promise<NormalizedResponse> {
    const { content, devinId } = await runDevin(config, req);
    return {
      id: devinId,
      model: req.model,
      content,
      input_tokens: estimateTokens(requestText(req)),
      output_tokens: estimateTokens(content),
      finish_reason: 'stop',
    };
  },

  async stream(config, req, onChunk): Promise<void> {
    const result = await this.complete(config, req);
    onChunk({ delta: result.content, done: false, model: result.model });
    onChunk({
      delta: '',
      done: true,
      model: result.model,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      finish_reason: result.finish_reason,
    });
  },
};
