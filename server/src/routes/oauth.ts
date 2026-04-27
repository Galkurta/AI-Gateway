import { createHash, randomBytes } from 'node:crypto';
import http, { type Server } from 'node:http';
import { Router, type Request, type Response as ExpressResponse } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db/index.js';

type OAuthProvider =
  | 'iflow' | 'qwen' | 'github' | 'kimi-coding' | 'kilocode' | 'codebuddy' | 'claude' | 'cline'
  | 'gemini-cli' | 'antigravity' | 'codex' | 'kiro' | 'cursor' | 'gitlab';

type OAuthStatus =
  | { status: 'pending'; provider: OAuthProvider; createdAt: number; targetProviderId?: string; deviceCode?: string; codeVerifier?: string; intervalMs?: number; lastPollAt?: number; userCode?: string; verificationUri?: string; authUrl?: string; redirectUri?: string }
  | { status: 'complete'; provider: OAuthProvider; createdAt: number; providerId: string; email?: string }
  | { status: 'error'; provider: OAuthProvider; createdAt: number; error: string };

const IFLOW_CLIENT_ID = process.env.IFLOW_CLIENT_ID ?? '10009311001';
const IFLOW_CLIENT_SECRET = process.env.IFLOW_CLIENT_SECRET ?? '4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW';
const IFLOW_AUTHORIZE_URL = 'https://iflow.cn/oauth';
const IFLOW_TOKEN_URL = 'https://iflow.cn/oauth/token';
const IFLOW_USERINFO_URL = 'https://iflow.cn/api/oauth/getUserInfo';
const IFLOW_BASE_URL = 'https://apis.iflow.cn/v1';

const QWEN_CLIENT_ID = process.env.QWEN_CLIENT_ID ?? 'f0304373b74a44d2b584a3fb70ca9e56';
const QWEN_DEVICE_CODE_URL = process.env.QWEN_DEVICE_CODE_URL ?? 'https://chat.qwen.ai/api/v1/oauth2/device/code';
const QWEN_TOKEN_URL = process.env.QWEN_TOKEN_URL ?? 'https://chat.qwen.ai/api/v1/oauth2/token';
const QWEN_SCOPE = 'openid profile email model.completion';

const GITHUB_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID ?? 'Iv1.b507a08c87ecfe98';
const KIMI_CODING_CLIENT_ID = process.env.KIMI_CODING_OAUTH_CLIENT_ID ?? '17e5f671-d194-4dfb-9706-5516cb48c098';
const KILOCODE_BASE_URL = 'https://api.kilo.ai';
const CODEBUDDY_BASE_URL = 'https://copilot.tencent.com';
const CLAUDE_CLIENT_ID = process.env.CLAUDE_OAUTH_CLIENT_ID ?? '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const CLAUDE_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const CLAUDE_SCOPE = 'org:create_api_key user:profile user:inference';
const CLINE_AUTHORIZE_URL = 'https://api.cline.bot/api/v1/auth/authorize';
const CLINE_TOKEN_EXCHANGE_URL = 'https://api.cline.bot/api/v1/auth/token';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo';
const GEMINI_CLIENT_ID = process.env.GEMINI_OAUTH_CLIENT_ID ?? '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GEMINI_CLIENT_SECRET = process.env.GEMINI_OAUTH_CLIENT_SECRET ?? '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';
const ANTIGRAVITY_CLIENT_ID = process.env.ANTIGRAVITY_OAUTH_CLIENT_ID ?? '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_CLIENT_SECRET = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET ?? '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';
const CODEX_CLIENT_ID = process.env.CODEX_OAUTH_CLIENT_ID ?? 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const KIRO_START_URL = 'https://view.awsapps.com/start';
const GITLAB_BASE_URL = process.env.GITLAB_BASE_URL ?? 'https://gitlab.com';
const GITLAB_CLIENT_ID = process.env.GITLAB_CLIENT_ID ?? '';
const GITLAB_CLIENT_SECRET = process.env.GITLAB_CLIENT_SECRET ?? '';

const oauthSessions = new Map<string, OAuthStatus>();
let codexProxyServer: Server | null = null;
let codexProxyTimer: NodeJS.Timeout | null = null;

export const oauthAdminRouter = Router();
export const oauthPublicRouter = Router();

function publicBaseUrl(req: { protocol: string; get(name: string): string | undefined }): string {
  const configured = process.env.PUBLIC_BASE_URL ?? process.env.BASE_URL ?? process.env.NEXT_PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, '');
  const host = req.get('host') ?? `localhost:${process.env.PORT ?? '3000'}`;
  return `${req.protocol}://${host}`;
}

function localCallbackUri(req: { get(name: string): string | undefined }): string {
  const host = req.get('host') ?? `localhost:${process.env.PORT ?? '3000'}`;
  const port = host.includes(':') ? host.split(':').pop() : process.env.PORT ?? '3000';
  return `http://localhost:${port}/callback`;
}

function localAppPort(req: { get(name: string): string | undefined }): number {
  const host = req.get('host') ?? `localhost:${process.env.PORT ?? '3000'}`;
  const parsed = Number.parseInt(host.includes(':') ? host.split(':').pop() ?? '' : process.env.PORT ?? '3000', 10);
  return Number.isFinite(parsed) ? parsed : 3000;
}

function stopCodexProxy(): void {
  if (codexProxyTimer) clearTimeout(codexProxyTimer);
  codexProxyTimer = null;
  if (codexProxyServer) codexProxyServer.close();
  codexProxyServer = null;
}

async function startCodexProxy(appPort: number): Promise<void> {
  if (codexProxyServer) return;
  await new Promise<void>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost:1455');
      if (url.pathname === '/callback' || url.pathname === '/auth/callback') {
        res.writeHead(302, { Location: `http://localhost:${appPort}/callback${url.search}` });
        res.end();
        stopCodexProxy();
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });
    server.once('error', reject);
    server.listen(1455, '127.0.0.1', () => {
      codexProxyServer = server;
      codexProxyTimer = setTimeout(() => stopCodexProxy(), 300000);
      resolve();
    });
  });
}

function buildIflowAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    loginMethod: 'phone',
    type: 'phone',
    redirect: redirectUri,
    state,
    client_id: IFLOW_CLIENT_ID,
  });
  return `${IFLOW_AUTHORIZE_URL}?${params}`;
}

function buildClaudeAuthUrl(redirectUri: string, state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLAUDE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: CLAUDE_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${CLAUDE_AUTHORIZE_URL}?${params}`;
}

function buildClineAuthUrl(redirectUri: string): string {
  const params = new URLSearchParams({
    client_type: 'extension',
    callback_url: redirectUri,
    redirect_uri: redirectUri,
  });
  return `${CLINE_AUTHORIZE_URL}?${params}`;
}

function buildGoogleAuthUrl(provider: 'gemini-cli' | 'antigravity', redirectUri: string, state: string): string {
  const scopes = provider === 'antigravity'
    ? [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/cclog',
        'https://www.googleapis.com/auth/experimentsandconfigs',
      ]
    : [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ];
  const params = new URLSearchParams({
    client_id: provider === 'antigravity' ? ANTIGRAVITY_CLIENT_ID : GEMINI_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function buildCodexAuthUrl(redirectUri: string, state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs',
    state,
  });
  return `${CODEX_AUTHORIZE_URL}?${params}`;
}

function buildGitlabAuthUrl(redirectUri: string, state: string, codeChallenge: string): string {
  if (!GITLAB_CLIENT_ID) throw new Error('Set GITLAB_CLIENT_ID and optional GITLAB_CLIENT_SECRET in server/.env before using GitLab OAuth.');
  const params = new URLSearchParams({
    client_id: GITLAB_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    scope: 'api read_user',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${GITLAB_BASE_URL.replace(/\/$/, '')}/oauth/authorize?${params}`;
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(text.slice(0, 300));
  }
}

async function exchangeIflowCode(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const basicAuth = Buffer.from(`${IFLOW_CLIENT_ID}:${IFLOW_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(IFLOW_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: IFLOW_CLIENT_ID,
      client_secret: IFLOW_CLIENT_SECRET,
    }),
  });
  const json = await readJson(res);
  if (!res.ok) throw new Error(`iFlow token exchange failed ${res.status}: ${JSON.stringify(json)}`);
  if (typeof json.access_token !== 'string') throw new Error(`iFlow token exchange did not return access_token: ${JSON.stringify(json)}`);
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : undefined,
  };
}

async function getIflowUserInfo(accessToken: string): Promise<{ apiKey: string; email?: string }> {
  const res = await fetch(`${IFLOW_USERINFO_URL}?accessToken=${encodeURIComponent(accessToken)}`, {
    headers: { Accept: 'application/json' },
  });
  const json = await readJson(res);
  if (!res.ok) throw new Error(`iFlow user info failed ${res.status}: ${JSON.stringify(json)}`);
  const data = json.data;
  if (!data || typeof data !== 'object') throw new Error(`iFlow user info did not return data: ${JSON.stringify(json)}`);
  const record = data as Record<string, unknown>;
  if (typeof record.apiKey !== 'string' || !record.apiKey) throw new Error('iFlow user info did not return apiKey.');
  const email = typeof record.email === 'string'
    ? record.email
    : typeof record.phone === 'string'
      ? record.phone
      : undefined;
  return { apiKey: record.apiKey, email };
}

async function exchangeClaudeCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  state: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string }> {
  let authCode = code;
  let codeState = '';
  if (authCode.includes('#')) {
    const parts = authCode.split('#');
    authCode = parts[0] ?? '';
    codeState = parts[1] ?? '';
  }

  const res = await fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      code: authCode,
      state: codeState || state,
      grant_type: 'authorization_code',
      client_id: CLAUDE_CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  const json = await readJson(res);
  if (!res.ok) throw new Error(`Claude token exchange failed ${res.status}: ${JSON.stringify(json)}`);
  if (typeof json.access_token !== 'string') throw new Error(`Claude token exchange did not return access_token: ${JSON.stringify(json)}`);
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : undefined,
    scope: typeof json.scope === 'string' ? json.scope : undefined,
  };
}

async function exchangeClineCode(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken?: string; email?: string; expiresIn?: number }> {
  try {
    let base64 = code;
    const padding = (4 - (base64.length % 4)) % 4;
    if (padding) base64 += '='.repeat(padding);
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    const lastBrace = decoded.lastIndexOf('}');
    if (lastBrace === -1) throw new Error('No JSON found in decoded Cline code.');
    const tokenData = JSON.parse(decoded.slice(0, lastBrace + 1)) as Record<string, unknown>;
    if (typeof tokenData.accessToken !== 'string') throw new Error('Decoded Cline code did not include accessToken.');
    const expiresAt = typeof tokenData.expiresAt === 'string' ? Date.parse(tokenData.expiresAt) : undefined;
    return {
      accessToken: tokenData.accessToken,
      refreshToken: typeof tokenData.refreshToken === 'string' ? tokenData.refreshToken : undefined,
      email: typeof tokenData.email === 'string' ? tokenData.email : undefined,
      expiresIn: expiresAt && Number.isFinite(expiresAt) ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : undefined,
    };
  } catch {
    const res = await fetch(CLINE_TOKEN_EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_type: 'extension',
        redirect_uri: redirectUri,
      }),
    });
    const json = await readJson(res);
    if (!res.ok) throw new Error(`Cline token exchange failed ${res.status}: ${JSON.stringify(json)}`);
    const data = isRecord(json.data) ? json.data : json;
    const userInfo = isRecord(data.userInfo) ? data.userInfo : {};
    const accessToken = typeof data.accessToken === 'string' ? data.accessToken : undefined;
    if (!accessToken) throw new Error(`Cline token exchange did not return accessToken: ${JSON.stringify(json)}`);
    const expiresAt = typeof data.expiresAt === 'string' ? Date.parse(data.expiresAt) : undefined;
    return {
      accessToken,
      refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken : undefined,
      email: typeof userInfo.email === 'string' ? userInfo.email : undefined,
      expiresIn: expiresAt && Number.isFinite(expiresAt) ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : undefined,
    };
  }
}

async function exchangeGoogleCode(provider: 'gemini-cli' | 'antigravity', code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken?: string; email?: string; expiresIn?: number; projectId?: string }> {
  const clientId = provider === 'antigravity' ? ANTIGRAVITY_CLIENT_ID : GEMINI_CLIENT_ID;
  const clientSecret = provider === 'antigravity' ? ANTIGRAVITY_CLIENT_SECRET : GEMINI_CLIENT_SECRET;
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const json = await readJson(res);
  if (!res.ok || typeof json.access_token !== 'string') throw new Error(`${provider} token exchange failed ${res.status}: ${JSON.stringify(json)}`);

  const userRes = await fetch(`${GOOGLE_USERINFO_URL}?alt=json`, { headers: { Authorization: `Bearer ${json.access_token}` } });
  const user = userRes.ok ? await readJson(userRes) : {};
  let projectId = '';
  try {
    const loadRes = await fetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
      method: 'POST',
      headers: { Authorization: `Bearer ${json.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: { ideType: 9, platform: process.platform === 'win32' ? 5 : 3, pluginType: 2 }, mode: 1 }),
    });
    const load = loadRes.ok ? await readJson(loadRes) : {};
    const project = load.cloudaicompanionProject;
    projectId = typeof project === 'string'
      ? project
      : isRecord(project) && typeof project.id === 'string'
        ? project.id
        : '';
  } catch {}

  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : undefined,
    email: typeof user.email === 'string' ? user.email : undefined,
    projectId,
  };
}

async function exchangeCodexCode(code: string, redirectUri: string, codeVerifier: string): Promise<{ accessToken: string; refreshToken?: string; email?: string; expiresIn?: number; idToken?: string }> {
  const res = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CODEX_CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  const json = await readJson(res);
  if (!res.ok || typeof json.access_token !== 'string') throw new Error(`Codex token exchange failed ${res.status}: ${JSON.stringify(json)}`);
  const idToken = typeof json.id_token === 'string' ? json.id_token : undefined;
  const payload = idToken ? decodeJwtPayload(idToken) : undefined;
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : undefined,
    idToken,
    email: isRecord(payload) && typeof payload.email === 'string' ? payload.email : undefined,
  };
}

async function exchangeGitlabCode(code: string, redirectUri: string, codeVerifier: string): Promise<{ accessToken: string; refreshToken?: string; email?: string; expiresIn?: number }> {
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: GITLAB_CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  };
  if (GITLAB_CLIENT_SECRET) params.client_secret = GITLAB_CLIENT_SECRET;
  const res = await fetch(`${GITLAB_BASE_URL.replace(/\/$/, '')}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params),
  });
  const json = await readJson(res);
  if (!res.ok || typeof json.access_token !== 'string') throw new Error(`GitLab token exchange failed ${res.status}: ${JSON.stringify(json)}`);
  const userRes = await fetch(`${GITLAB_BASE_URL.replace(/\/$/, '')}/api/v4/user`, { headers: { Authorization: `Bearer ${json.access_token}` } });
  const user = userRes.ok ? await readJson(userRes) : {};
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : undefined,
    email: typeof user.email === 'string' ? user.email : typeof user.username === 'string' ? user.username : undefined,
  };
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  try {
    const part = jwt.split('.')[1];
    if (!part) return undefined;
    const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function upsertIflowProvider(apiKey: string, email?: string, targetProviderId?: string, oauth?: { accessToken?: string; refreshToken?: string; expiresIn?: number }): string {
  const account = email ?? `iflow-${apiKey.slice(0, 12)}`;
  const now = Date.now();
  const name = providerStoredName('iflow', account);
  const notes = `Connected via iFlow OAuth (${account})`;
  const extraHeadersObject = { 'User-Agent': 'iFlow-Cli' };
  const cookiesObject = {
    oauth_provider: 'iflow',
    oauth_account: account,
    access_token: oauth?.accessToken,
    oauth_access_token: oauth?.accessToken,
    refresh_token: oauth?.refreshToken,
    access_token_expires_at: oauth?.expiresIn ? String(now + oauth.expiresIn * 1000) : undefined,
    connected_at: new Date(now).toISOString(),
  };
  if (upsertOAuthAccount({
    targetProviderId,
    provider: 'iflow',
    account,
    accessToken: apiKey,
    extraHeaders: extraHeadersObject,
    cookies: cookiesObject,
  })) {
    return targetProviderId!;
  }

  const match = providerAccountMatch('iflow', account);
  const existing = db.prepare(`SELECT id FROM providers WHERE ${match.clause} ORDER BY created_at ASC LIMIT 1`)
    .get(...match.params) as { id: string } | undefined;
  const extraHeaders = JSON.stringify(extraHeadersObject);
  const cookies = JSON.stringify(cookiesObject);

  if (existing) {
    db.prepare(`
      UPDATE providers SET name = ?, api_key = ?, cookies = ?, extra_headers = ?, notes = ?, enabled = 1, updated_at = ?
      WHERE id = ?
    `).run(name, apiKey, cookies, extraHeaders, notes, now, existing.id);
    return existing.id;
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, api_key, cookies, extra_headers, notes, priority, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
  `).run(id, name, 'openai-compatible', IFLOW_BASE_URL, apiKey, cookies, extraHeaders, notes, now, now);
  return id;
}

function qwenBaseUrl(resourceUrl?: string): string {
  const host = resourceUrl
    ? resourceUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
    : 'portal.qwen.ai';
  return `https://${host}/v1`;
}

function qwenHeaders(): Record<string, string> {
  const userAgent = 'QwenCode/0.12.3 (linux; x64)';
  return {
    'User-Agent': userAgent,
    'X-DashScope-AuthType': 'qwen-oauth',
    'X-DashScope-CacheControl': 'enable',
    'X-DashScope-UserAgent': userAgent,
    'X-Stainless-Arch': 'x64',
    'X-Stainless-Lang': 'js',
    'X-Stainless-Os': 'Linux',
    'X-Stainless-Package-Version': '5.11.0',
    'X-Stainless-Retry-Count': '1',
    'X-Stainless-Runtime': 'node',
    'X-Stainless-Runtime-Version': 'v18.19.1',
    'Accept-Language': '*',
    'Sec-Fetch-Mode': 'cors',
  };
}

function upsertQwenProvider(accessToken: string, refreshToken?: string, resourceUrl?: string, targetProviderId?: string, expiresIn?: number): string {
  const baseUrl = qwenBaseUrl(resourceUrl);
  const now = Date.now();
  const account = `qwen-${resourceUrl ?? refreshToken?.slice(0, 12) ?? accessToken.slice(0, 12)}`;
  const name = providerStoredName('qwen', account);
  const notes = 'Connected via Qwen device-code OAuth';
  const cookiesObject = {
    oauth_provider: 'qwen',
    oauth_account: account,
    access_token: accessToken,
    oauth_access_token: accessToken,
    qwen_refresh_token: refreshToken,
    refresh_token: refreshToken,
    qwen_resource_url: resourceUrl,
    access_token_expires_at: expiresIn ? String(now + expiresIn * 1000) : undefined,
    qwen_connected_at: new Date(now).toISOString(),
  };
  const extraHeadersObject = qwenHeaders();
  if (upsertOAuthAccount({
    targetProviderId,
    provider: 'qwen',
    account,
    accessToken,
    refreshToken,
    extraHeaders: extraHeadersObject,
    cookies: cookiesObject,
  })) {
    return targetProviderId!;
  }

  const match = providerAccountMatch('qwen', account);
  const existing = db.prepare(`SELECT id FROM providers WHERE ${match.clause} ORDER BY created_at ASC LIMIT 1`)
    .get(...match.params) as { id: string } | undefined;
  const cookies = JSON.stringify(cookiesObject);
  const extraHeaders = JSON.stringify(extraHeadersObject);

  if (existing) {
    db.prepare(`
      UPDATE providers SET name = ?, base_url = ?, api_key = ?, cookies = ?, extra_headers = ?, notes = ?, enabled = 1, updated_at = ?
      WHERE id = ?
    `).run(name, baseUrl, accessToken, cookies, extraHeaders, notes, now, existing.id);
    return existing.id;
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, api_key, cookies, extra_headers, notes, priority, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
  `).run(id, name, 'openai-compatible', baseUrl, accessToken, cookies, extraHeaders, notes, now, now);
  return id;
}

function providerAccountMatch(provider: OAuthProvider, email?: string): { clause: string; params: unknown[] } {
  const providerPattern = `%"oauth_provider":"${provider.replace(/"/g, '\\"')}"%`;
  if (!email) return { clause: '(cookies LIKE ? OR name = ?)', params: [providerPattern, providerDisplayName(provider)] };
  return {
    clause: 'cookies LIKE ? AND cookies LIKE ?',
    params: [providerPattern, `%"oauth_account":"${email.replace(/"/g, '\\"')}"%`],
  };
}

function providerDisplayName(provider: OAuthProvider): string {
  switch (provider) {
    case 'gemini-cli': return 'Gemini CLI OAuth';
    case 'antigravity': return 'Antigravity OAuth';
    case 'codex': return 'Codex OAuth';
    case 'kiro': return 'Kiro OAuth';
    case 'cursor': return 'Cursor Import';
    case 'gitlab': return 'GitLab Duo OAuth';
    case 'claude': return 'Claude Code OAuth';
    case 'cline': return 'Cline OAuth';
    case 'github': return 'GitHub Copilot';
    case 'kimi-coding': return 'Kimi Coding OAuth';
    case 'kilocode': return 'KiloCode OAuth';
    case 'codebuddy': return 'CodeBuddy OAuth';
    case 'qwen': return 'Qwen OAuth';
    case 'iflow': return 'iFlow AI';
  }
}

function providerStoredName(provider: OAuthProvider, account?: string): string {
  if (!account) return providerDisplayName(provider);
  const compact = account.length > 42 ? `${account.slice(0, 39)}...` : account;
  return `${providerDisplayName(provider)} (${compact})`;
}

function targetProviderIdFromRequest(req: Request): string | undefined {
  const value = (req.body as { target_provider_id?: unknown } | undefined)?.target_provider_id;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function upsertOAuthAccount(options: {
  targetProviderId?: string;
  provider: OAuthProvider;
  account: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  extraHeaders?: Record<string, string>;
  cookies?: Record<string, unknown>;
}): boolean {
  if (!options.targetProviderId) return false;
  const target = db.prepare('SELECT id FROM providers WHERE id = ?').get(options.targetProviderId) as { id: string } | undefined;
  if (!target) throw new Error('Target provider not found for OAuth account.');

  const now = Date.now();
  const cookies = JSON.stringify({
    ...(options.cookies ?? {}),
    oauth_provider: options.provider,
    oauth_account: options.account,
    access_token: options.cookies?.access_token ?? options.accessToken,
    oauth_access_token: options.cookies?.oauth_access_token ?? options.cookies?.access_token ?? options.accessToken,
    refresh_token: options.refreshToken,
    access_token_expires_at: options.expiresIn ? String(now + options.expiresIn * 1000) : undefined,
    connected_at: new Date(now).toISOString(),
  });
  const extraHeaders = JSON.stringify(options.extraHeaders ?? {});
  const id = uuid();
  db.prepare(`
    INSERT INTO provider_accounts
      (id, provider_id, name, auth_type, api_key, cookies, extra_headers, enabled, priority, created_at, updated_at)
    VALUES (?, ?, ?, 'oauth', ?, ?, ?, 1, 0, ?, ?)
    ON CONFLICT(provider_id, name) DO UPDATE SET
      auth_type = 'oauth',
      api_key = excluded.api_key,
      cookies = excluded.cookies,
      extra_headers = excluded.extra_headers,
      enabled = 1,
      updated_at = excluded.updated_at
  `).run(id, options.targetProviderId, options.account, options.accessToken, cookies, extraHeaders, now, now);
  db.prepare('UPDATE providers SET enabled = 1, updated_at = ? WHERE id = ?').run(now, options.targetProviderId);
  return true;
}

function upsertBearerProvider(options: {
  targetProviderId?: string;
  provider: OAuthProvider;
  type: string;
  baseUrl: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  email?: string;
  notes: string;
  extraHeaders?: Record<string, string>;
  cookies?: Record<string, unknown>;
}): string {
  const account = options.email ?? options.cookies?.oauth_account ?? `${options.provider}-${options.accessToken.slice(0, 12)}`;
  const accountName = typeof account === 'string' ? account : `${options.provider}-${options.accessToken.slice(0, 12)}`;
  if (upsertOAuthAccount({
    targetProviderId: options.targetProviderId,
    provider: options.provider,
    account: accountName,
    accessToken: options.accessToken,
    refreshToken: options.refreshToken,
    expiresIn: options.expiresIn,
    extraHeaders: options.extraHeaders,
    cookies: options.cookies,
  })) {
    return options.targetProviderId!;
  }
  const match = providerAccountMatch(options.provider, typeof account === 'string' ? account : undefined);
  const existing = db.prepare(`SELECT id FROM providers WHERE ${match.clause} ORDER BY created_at ASC LIMIT 1`)
    .get(...match.params) as { id: string } | undefined;
  const now = Date.now();
  const cookies = JSON.stringify({
    ...(options.cookies ?? {}),
    oauth_provider: options.provider,
    oauth_account: account,
    access_token: options.accessToken,
    oauth_access_token: options.accessToken,
    refresh_token: options.refreshToken,
    access_token_expires_at: options.expiresIn ? String(now + options.expiresIn * 1000) : undefined,
    connected_at: new Date(now).toISOString(),
  });
  const extraHeaders = JSON.stringify(options.extraHeaders ?? {});
  const name = providerStoredName(options.provider, typeof account === 'string' ? account : undefined);

  if (existing) {
    db.prepare(`
      UPDATE providers SET name = ?, type = ?, base_url = ?, api_key = ?, cookies = ?, extra_headers = ?, notes = ?, enabled = 1, updated_at = ?
      WHERE id = ?
    `).run(name, options.type, options.baseUrl, options.accessToken, cookies, extraHeaders, options.notes, now, existing.id);
    return existing.id;
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, api_key, cookies, extra_headers, notes, priority, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
  `).run(id, name, options.type, options.baseUrl, options.accessToken, cookies, extraHeaders, options.notes, now, now);
  return id;
}

type DeviceStart = {
  deviceCode: string;
  userCode?: string;
  verificationUri?: string;
  authUrl: string;
  intervalMs: number;
  codeVerifier?: string;
};

async function startDeviceFlow(provider: OAuthProvider): Promise<DeviceStart> {
  if (provider === 'qwen') return startQwenDeviceFlow();

  if (provider === 'github') {
    const res = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: GITHUB_CLIENT_ID, scope: 'read:user' }),
    });
    const json = await readJson(res);
    if (!res.ok || typeof json.device_code !== 'string') throw new Error(`GitHub device-code failed ${res.status}: ${JSON.stringify(json)}`);
    return {
      deviceCode: json.device_code,
      userCode: typeof json.user_code === 'string' ? json.user_code : undefined,
      verificationUri: typeof json.verification_uri === 'string' ? json.verification_uri : undefined,
      authUrl: typeof json.verification_uri === 'string' ? json.verification_uri : 'https://github.com/login/device',
      intervalMs: typeof json.interval === 'number' ? json.interval * 1000 : 5000,
    };
  }

  if (provider === 'kimi-coding') {
    const res = await fetch('https://auth.kimi.com/api/oauth/device_authorization', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: KIMI_CODING_CLIENT_ID }),
    });
    const json = await readJson(res);
    if (!res.ok || typeof json.device_code !== 'string') throw new Error(`Kimi device-code failed ${res.status}: ${JSON.stringify(json)}`);
    const userCode = typeof json.user_code === 'string' ? json.user_code : undefined;
    return {
      deviceCode: json.device_code,
      userCode,
      verificationUri: typeof json.verification_uri === 'string' ? json.verification_uri : 'https://www.kimi.com/code/authorize_device',
      authUrl: typeof json.verification_uri_complete === 'string'
        ? json.verification_uri_complete
        : `https://www.kimi.com/code/authorize_device${userCode ? `?user_code=${encodeURIComponent(userCode)}` : ''}`,
      intervalMs: typeof json.interval === 'number' ? json.interval * 1000 : 5000,
    };
  }

  if (provider === 'kilocode') {
    const res = await fetch(`${KILOCODE_BASE_URL}/api/device-auth/codes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const json = await readJson(res);
    if (!res.ok || typeof json.code !== 'string') throw new Error(`KiloCode device-code failed ${res.status}: ${JSON.stringify(json)}`);
    return {
      deviceCode: json.code,
      userCode: json.code,
      verificationUri: typeof json.verificationUrl === 'string' ? json.verificationUrl : undefined,
      authUrl: typeof json.verificationUrl === 'string' ? json.verificationUrl : 'https://kilocode.ai',
      intervalMs: 3000,
    };
  }

  if (provider === 'codebuddy') {
    const res = await fetch(`${CODEBUDDY_BASE_URL}/v2/plugin/auth/state?platform=CLI`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Domain': 'copilot.tencent.com',
        'X-No-Authorization': 'true',
        'X-No-User-Id': 'true',
        'X-Product': 'SaaS',
      },
      body: '{}',
    });
    const json = await readJson(res);
    const data = isRecord(json.data) ? json.data : {};
    if (!res.ok || json.code !== 0 || typeof data.state !== 'string' || typeof data.authUrl !== 'string') {
      throw new Error(`CodeBuddy device-code failed ${res.status}: ${JSON.stringify(json)}`);
    }
    return {
      deviceCode: data.state,
      authUrl: data.authUrl,
      verificationUri: data.authUrl,
      intervalMs: 5000,
    };
  }

  if (provider === 'kiro') {
    const region = process.env.KIRO_REGION ?? 'us-east-1';
    const registerRes = await fetch(`https://oidc.${region}.amazonaws.com/client/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        clientName: 'kiro-oauth-client',
        clientType: 'public',
        scopes: ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations'],
        grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        issuerUrl: 'https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6',
      }),
    });
    const client = await readJson(registerRes);
    if (!registerRes.ok || typeof client.clientId !== 'string' || typeof client.clientSecret !== 'string') {
      throw new Error(`Kiro client registration failed ${registerRes.status}: ${JSON.stringify(client)}`);
    }
    const deviceRes = await fetch(`https://oidc.${region}.amazonaws.com/device_authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        startUrl: process.env.KIRO_START_URL ?? KIRO_START_URL,
      }),
    });
    const json = await readJson(deviceRes);
    if (!deviceRes.ok || typeof json.deviceCode !== 'string') throw new Error(`Kiro device authorization failed ${deviceRes.status}: ${JSON.stringify(json)}`);
    return {
      deviceCode: json.deviceCode,
      userCode: typeof json.userCode === 'string' ? json.userCode : undefined,
      verificationUri: typeof json.verificationUri === 'string' ? json.verificationUri : undefined,
      authUrl: typeof json.verificationUriComplete === 'string' ? json.verificationUriComplete : String(json.verificationUri ?? 'https://view.awsapps.com/start'),
      intervalMs: typeof json.interval === 'number' ? json.interval * 1000 : 5000,
      codeVerifier: JSON.stringify({ clientId: client.clientId, clientSecret: client.clientSecret, region }),
    };
  }

  throw new Error(`Unsupported OAuth provider: ${provider}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function startQwenDeviceFlow(): Promise<{
  deviceCode: string;
  userCode?: string;
  verificationUri?: string;
  authUrl: string;
  intervalMs: number;
  codeVerifier: string;
}> {
  const { verifier, challenge } = pkcePair();
  const res = await fetch(QWEN_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: QWEN_CLIENT_ID,
      scope: QWEN_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }),
  });
  const json = await readJson(res);
  if (!res.ok) throw new Error(`Qwen device-code request failed ${res.status}: ${JSON.stringify(json)}`);
  if (typeof json.device_code !== 'string') throw new Error(`Qwen device-code response missing device_code: ${JSON.stringify(json)}`);
  const verificationUri = typeof json.verification_uri === 'string' ? json.verification_uri : undefined;
  const complete = typeof json.verification_uri_complete === 'string' ? json.verification_uri_complete : undefined;
  return {
    deviceCode: json.device_code,
    userCode: typeof json.user_code === 'string' ? json.user_code : undefined,
    verificationUri,
    authUrl: complete ?? verificationUri ?? 'https://chat.qwen.ai/',
    intervalMs: typeof json.interval === 'number' ? json.interval * 1000 : 5000,
    codeVerifier: verifier,
  };
}

async function pollQwenToken(session: Extract<OAuthStatus, { status: 'pending' }>): Promise<OAuthStatus> {
  if (!session.deviceCode || !session.codeVerifier) throw new Error('Qwen OAuth session is missing device_code or code_verifier.');
  if (Date.now() - (session.lastPollAt ?? 0) < (session.intervalMs ?? 5000)) return session;
  session.lastPollAt = Date.now();

  const res = await fetch(QWEN_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: QWEN_CLIENT_ID,
      device_code: session.deviceCode,
      code_verifier: session.codeVerifier,
    }),
  });
  const json = await readJson(res);
  if (res.ok) {
    if (typeof json.access_token !== 'string') throw new Error(`Qwen token response missing access_token: ${JSON.stringify(json)}`);
    const providerId = upsertQwenProvider(
      json.access_token,
      typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
      typeof json.resource_url === 'string' ? json.resource_url : undefined,
      session.targetProviderId,
      typeof json.expires_in === 'number' ? json.expires_in : undefined,
    );
    return { status: 'complete', provider: 'qwen', createdAt: session.createdAt, providerId };
  }

  const err = typeof json.error === 'string' ? json.error : '';
  if (err === 'authorization_pending') return session;
  if (err === 'slow_down') {
    session.intervalMs = (session.intervalMs ?? 5000) + 5000;
    return session;
  }
  throw new Error(`Qwen token polling failed ${res.status}: ${JSON.stringify(json)}`);
}

async function pollGenericDeviceProvider(session: Extract<OAuthStatus, { status: 'pending' }>): Promise<OAuthStatus> {
  if (session.provider === 'qwen') return pollQwenToken(session);
  if (!session.deviceCode) throw new Error(`${session.provider} OAuth session is missing device_code.`);
  if (Date.now() - (session.lastPollAt ?? 0) < (session.intervalMs ?? 5000)) return session;
  session.lastPollAt = Date.now();

  if (session.provider === 'github') {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        device_code: session.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const json = await readJson(res);
    if (!res.ok || typeof json.access_token !== 'string') {
      const err = typeof json.error === 'string' ? json.error : '';
      if (err === 'authorization_pending') return session;
      if (err === 'slow_down') {
        session.intervalMs = (session.intervalMs ?? 5000) + 5000;
        return session;
      }
      throw new Error(`GitHub token polling failed ${res.status}: ${JSON.stringify(json)}`);
    }

    const copilotRes = await fetch('https://api.github.com/copilot_internal/v2/token', {
      headers: {
        Authorization: `token ${json.access_token}`,
        Accept: 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'GitHubCopilotChat/0.26.7',
      },
    });
    const copilot = await readJson(copilotRes);
    if (!copilotRes.ok || typeof copilot.token !== 'string') throw new Error(`GitHub Copilot token failed ${copilotRes.status}: ${JSON.stringify(copilot)}`);

    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${json.access_token}`,
        Accept: 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'GitHubCopilotChat/0.26.7',
      },
    });
    const user = userRes.ok ? await readJson(userRes) : {};
    const login = typeof user.login === 'string' ? user.login : undefined;
    const providerId = upsertBearerProvider({
      targetProviderId: session.targetProviderId,
      provider: 'github',
      type: 'openai-compatible',
      baseUrl: 'https://api.githubcopilot.com/chat/completions',
      accessToken: copilot.token,
      expiresIn: typeof json.expires_in === 'number' ? json.expires_in : undefined,
      email: login,
      notes: login ? `Connected via GitHub Copilot OAuth (${login})` : 'Connected via GitHub Copilot OAuth',
      extraHeaders: {
        'copilot-integration-id': 'vscode-chat',
        'editor-version': 'vscode/1.110.0',
        'editor-plugin-version': 'copilot-chat/0.38.0',
        'user-agent': 'GitHubCopilotChat/0.38.0',
        'openai-intent': 'conversation-panel',
        'x-github-api-version': '2025-04-01',
        'x-vscode-user-agent-library-version': 'electron-fetch',
        'X-Initiator': 'user',
      },
      cookies: {
        github_access_token: json.access_token,
        refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
        github_access_token_expires_at: typeof json.expires_in === 'number' ? String(Date.now() + json.expires_in * 1000) : undefined,
        copilot_token_expires_at: copilot.expires_at,
      },
    });
    return { status: 'complete', provider: 'github', createdAt: session.createdAt, providerId, email: login };
  }

  if (session.provider === 'kimi-coding') {
    const res = await fetch('https://auth.kimi.com/api/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: KIMI_CODING_CLIENT_ID,
        device_code: session.deviceCode,
      }),
    });
    const json = await readJson(res);
    if (!res.ok || typeof json.access_token !== 'string') {
      const err = typeof json.error === 'string' ? json.error : '';
      if (err === 'authorization_pending') return session;
      if (err === 'slow_down') {
        session.intervalMs = (session.intervalMs ?? 5000) + 5000;
        return session;
      }
      throw new Error(`Kimi token polling failed ${res.status}: ${JSON.stringify(json)}`);
    }
    const kimiRefreshToken = typeof json.refresh_token === 'string' ? json.refresh_token : undefined;
    const providerId = upsertBearerProvider({
      targetProviderId: session.targetProviderId,
      provider: 'kimi-coding',
      type: 'anthropic-compatible',
      baseUrl: 'https://api.kimi.com/coding',
      accessToken: json.access_token,
      refreshToken: kimiRefreshToken,
      expiresIn: typeof json.expires_in === 'number' ? json.expires_in : undefined,
      notes: 'Connected via Kimi Coding device OAuth',
      extraHeaders: { 'X-Gateway-Auth-Scheme': 'bearer' },
      cookies: { oauth_account: `kimi-${String(kimiRefreshToken ?? json.access_token).slice(0, 12)}` },
    });
    return { status: 'complete', provider: 'kimi-coding', createdAt: session.createdAt, providerId };
  }

  if (session.provider === 'kilocode') {
    const res = await fetch(`${KILOCODE_BASE_URL}/api/device-auth/codes/${encodeURIComponent(session.deviceCode)}`);
    if (res.status === 202) return session;
    if (res.status === 403) throw new Error('KiloCode authorization denied by user.');
    if (res.status === 410) throw new Error('KiloCode authorization code expired.');
    const json = await readJson(res);
    if (!res.ok) throw new Error(`KiloCode polling failed ${res.status}: ${JSON.stringify(json)}`);
    if (json.status !== 'approved' || typeof json.token !== 'string') return session;

    let orgId: string | undefined;
    try {
      const profileRes = await fetch(`${KILOCODE_BASE_URL}/api/profile`, { headers: { Authorization: `Bearer ${json.token}` } });
      const profile = profileRes.ok ? await readJson(profileRes) : {};
      const orgs = Array.isArray(profile.organizations) ? profile.organizations : [];
      const first = isRecord(orgs[0]) ? orgs[0] : {};
      if (typeof first.id === 'string') orgId = first.id;
    } catch {}

    const email = typeof json.userEmail === 'string' ? json.userEmail : undefined;
    const providerId = upsertBearerProvider({
      targetProviderId: session.targetProviderId,
      provider: 'kilocode',
      type: 'openai-compatible',
      baseUrl: 'https://api.kilo.ai/api/openrouter/chat/completions',
      accessToken: json.token,
      email,
      notes: email ? `Connected via KiloCode OAuth (${email})` : 'Connected via KiloCode OAuth',
      extraHeaders: orgId ? { 'X-Kilocode-OrganizationID': orgId } : {},
      cookies: { org_id: orgId, oauth_account: email ?? (orgId ? `kilocode-${orgId}` : undefined) },
    });
    return { status: 'complete', provider: 'kilocode', createdAt: session.createdAt, providerId, email };
  }

  if (session.provider === 'codebuddy') {
    const res = await fetch(`${CODEBUDDY_BASE_URL}/v2/plugin/auth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Domain': 'copilot.tencent.com',
        'X-No-Authorization': 'true',
        'X-No-User-Id': 'true',
        'X-Product': 'SaaS',
      },
      body: JSON.stringify({ state: session.deviceCode }),
    });
    const json = await readJson(res);
    if (!res.ok) throw new Error(`CodeBuddy polling failed ${res.status}: ${JSON.stringify(json)}`);
    if (json.code === 11217) return session;
    const data = isRecord(json.data) ? json.data : {};
    if (json.code !== 0 || typeof data.accessToken !== 'string') throw new Error(`CodeBuddy authorization failed: ${JSON.stringify(json)}`);
    const codebuddyRefreshToken = typeof data.refreshToken === 'string' ? data.refreshToken : undefined;
    const providerId = upsertBearerProvider({
      targetProviderId: session.targetProviderId,
      provider: 'codebuddy',
      type: 'openai-compatible',
      baseUrl: 'https://copilot.tencent.com/v1',
      accessToken: data.accessToken,
      refreshToken: codebuddyRefreshToken,
      expiresIn: 86400,
      notes: 'Connected via CodeBuddy OAuth',
      cookies: { oauth_account: `codebuddy-${String(codebuddyRefreshToken ?? data.accessToken).slice(0, 12)}` },
    });
    return { status: 'complete', provider: 'codebuddy', createdAt: session.createdAt, providerId };
  }

  if (session.provider === 'kiro') {
    const extra = session.codeVerifier ? JSON.parse(session.codeVerifier) as Record<string, string> : {};
    const region = extra.region ?? 'us-east-1';
    const res = await fetch(`https://oidc.${region}.amazonaws.com/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        clientId: extra.clientId,
        clientSecret: extra.clientSecret,
        deviceCode: session.deviceCode,
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const json = await readJson(res);
    if (!res.ok || typeof json.accessToken !== 'string') {
      const err = typeof json.error === 'string' ? json.error : '';
      if (!err || err === 'authorization_pending' || err === 'AuthorizationPendingException') return session;
      if (err === 'slow_down') {
        session.intervalMs = (session.intervalMs ?? 5000) + 5000;
        return session;
      }
      throw new Error(`Kiro token polling failed ${res.status}: ${JSON.stringify(json)}`);
    }
    const account = `kiro-${String(json.refreshToken ?? json.accessToken).slice(0, 12)}`;
    const providerId = upsertBearerProvider({
      targetProviderId: session.targetProviderId,
      provider: 'kiro',
      type: 'kiro',
      baseUrl: 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse',
      accessToken: String(json.accessToken),
      refreshToken: typeof json.refreshToken === 'string' ? json.refreshToken : undefined,
      expiresIn: typeof json.expiresIn === 'number' ? json.expiresIn : undefined,
      notes: `Connected via Kiro device OAuth (${account})`,
      cookies: {
        oauth_account: account,
        client_id: extra.clientId,
        client_secret: extra.clientSecret,
        region,
        profile_arn: typeof json.profileArn === 'string' ? json.profileArn : undefined,
      },
    });
    return { status: 'complete', provider: 'kiro', createdAt: session.createdAt, providerId, email: account };
  }

  return session;
}

oauthAdminRouter.post('/iflow/start', (req, res) => {
  const state = randomBytes(24).toString('base64url');
  const redirectUri = localCallbackUri(req);
  const targetProviderId = targetProviderIdFromRequest(req);
  oauthSessions.set(state, { status: 'pending', provider: 'iflow', createdAt: Date.now(), targetProviderId, redirectUri });
  res.json({
    state,
    authUrl: buildIflowAuthUrl(redirectUri, state),
  });
});

oauthAdminRouter.get('/iflow/status/:state', (req, res) => {
  const status = oauthSessions.get(req.params.state);
  if (!status) {
    res.status(404).json({ error: 'OAuth session not found or expired' });
    return;
  }
  res.json(status);
});

oauthAdminRouter.post('/qwen/start', async (req, res) => {
  const state = randomBytes(24).toString('base64url');
  const targetProviderId = targetProviderIdFromRequest(req);
  try {
    const device = await startQwenDeviceFlow();
    oauthSessions.set(state, {
      status: 'pending',
      provider: 'qwen',
      createdAt: Date.now(),
      targetProviderId,
      deviceCode: device.deviceCode,
      codeVerifier: device.codeVerifier,
      intervalMs: device.intervalMs,
      lastPollAt: 0,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      authUrl: device.authUrl,
    });
    res.json({
      state,
      authUrl: device.authUrl,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

oauthAdminRouter.get('/qwen/status/:state', async (req, res) => {
  const status = oauthSessions.get(req.params.state);
  if (!status) {
    res.status(404).json({ error: 'OAuth session not found or expired' });
    return;
  }
  if (status.provider !== 'qwen' || status.status !== 'pending') {
    res.json(status);
    return;
  }
  try {
    const next = await pollQwenToken(status);
    oauthSessions.set(req.params.state, next);
    if (next.status === 'pending' && next.provider === 'qwen') {
      const { deviceCode: _deviceCode, codeVerifier: _codeVerifier, ...safe } = next;
      res.json(safe);
      return;
    }
    res.json(next);
  } catch (err) {
    const errorStatus: OAuthStatus = {
      status: 'error',
      provider: 'qwen',
      createdAt: status.createdAt,
      error: err instanceof Error ? err.message : String(err),
    };
    oauthSessions.set(req.params.state, errorStatus);
    res.json(errorStatus);
  }
});

oauthAdminRouter.post('/:provider/start', async (req, res) => {
  const provider = req.params.provider as OAuthProvider;
  if (!['github', 'kimi-coding', 'kilocode', 'codebuddy', 'claude', 'cline', 'gemini-cli', 'antigravity', 'codex', 'kiro', 'gitlab'].includes(provider)) {
    res.status(404).json({ error: `OAuth provider not supported here: ${req.params.provider}` });
    return;
  }

  const state = randomBytes(24).toString('base64url');
  const targetProviderId = targetProviderIdFromRequest(req);
  try {
    if (provider === 'claude') {
      const { verifier, challenge } = pkcePair();
      const redirectUri = localCallbackUri(req);
      const authUrl = buildClaudeAuthUrl(redirectUri, state, challenge);
      oauthSessions.set(state, {
        status: 'pending',
        provider,
        createdAt: Date.now(),
        targetProviderId,
        codeVerifier: verifier,
        intervalMs: 5000,
        lastPollAt: 0,
        authUrl,
        redirectUri,
      });
      res.json({ state, authUrl });
      return;
    }

    if (provider === 'cline') {
      const redirectUri = localCallbackUri(req);
      const authUrl = buildClineAuthUrl(redirectUri);
      oauthSessions.set(state, {
        status: 'pending',
        provider,
        createdAt: Date.now(),
        targetProviderId,
        intervalMs: 5000,
        lastPollAt: 0,
        authUrl,
        redirectUri,
      });
      res.json({ state, authUrl });
      return;
    }

    if (provider === 'gemini-cli' || provider === 'antigravity') {
      const redirectUri = localCallbackUri(req);
      const authUrl = buildGoogleAuthUrl(provider, redirectUri, state);
      oauthSessions.set(state, { status: 'pending', provider, createdAt: Date.now(), targetProviderId, intervalMs: 5000, lastPollAt: 0, authUrl, redirectUri });
      res.json({ state, authUrl });
      return;
    }

    if (provider === 'codex') {
      const { verifier, challenge } = pkcePair();
      await startCodexProxy(localAppPort(req));
      const redirectUri = 'http://localhost:1455/auth/callback';
      const authUrl = buildCodexAuthUrl(redirectUri, state, challenge);
      oauthSessions.set(state, { status: 'pending', provider, createdAt: Date.now(), targetProviderId, codeVerifier: verifier, intervalMs: 5000, lastPollAt: 0, authUrl, redirectUri });
      res.json({ state, authUrl });
      return;
    }

    if (provider === 'gitlab') {
      const { verifier, challenge } = pkcePair();
      const redirectUri = localCallbackUri(req);
      const authUrl = buildGitlabAuthUrl(redirectUri, state, challenge);
      oauthSessions.set(state, { status: 'pending', provider, createdAt: Date.now(), targetProviderId, codeVerifier: verifier, intervalMs: 5000, lastPollAt: 0, authUrl, redirectUri });
      res.json({ state, authUrl });
      return;
    }

    const device = await startDeviceFlow(provider);
    oauthSessions.set(state, {
      status: 'pending',
      provider,
      createdAt: Date.now(),
      targetProviderId,
      deviceCode: device.deviceCode,
      codeVerifier: device.codeVerifier,
      intervalMs: device.intervalMs,
      lastPollAt: 0,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      authUrl: device.authUrl,
    });
    res.json({
      state,
      authUrl: device.authUrl,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

oauthAdminRouter.get('/:provider/status/:state', async (req, res) => {
  const provider = req.params.provider as OAuthProvider;
  if (!['github', 'kimi-coding', 'kilocode', 'codebuddy', 'claude', 'cline', 'gemini-cli', 'antigravity', 'codex', 'kiro', 'gitlab'].includes(provider)) {
    res.status(404).json({ error: `OAuth provider not supported here: ${req.params.provider}` });
    return;
  }

  const status = oauthSessions.get(req.params.state);
  if (!status) {
    res.status(404).json({ error: 'OAuth session not found or expired' });
    return;
  }
  if (status.provider !== provider) {
    res.status(400).json({ error: `OAuth session belongs to ${status.provider}, not ${provider}` });
    return;
  }
  if (status.status !== 'pending') {
    res.json(status);
    return;
  }
  if (provider === 'claude' || provider === 'cline' || provider === 'gemini-cli' || provider === 'antigravity' || provider === 'codex' || provider === 'gitlab') {
    const { codeVerifier: _codeVerifier, ...safe } = status;
    res.json(safe);
    return;
  }

  try {
    const next = await pollGenericDeviceProvider(status);
    oauthSessions.set(req.params.state, next);
    if (next.status === 'pending') {
      const { deviceCode: _deviceCode, codeVerifier: _codeVerifier, ...safe } = next;
      res.json(safe);
      return;
    }
    res.json(next);
  } catch (err) {
    const errorStatus: OAuthStatus = {
      status: 'error',
      provider,
      createdAt: status.createdAt,
      error: err instanceof Error ? err.message : String(err),
    };
    oauthSessions.set(req.params.state, errorStatus);
    res.json(errorStatus);
  }
});

async function handleIflowCallback(req: Request, res: ExpressResponse): Promise<void> {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const error = typeof req.query.error === 'string' ? req.query.error : '';
  const session = oauthSessions.get(state);
  const createdAt = session?.createdAt ?? Date.now();

  try {
    if (!session || session.provider !== 'iflow' || session.status !== 'pending') throw new Error('OAuth state is invalid or expired.');
    if (error) throw new Error(error);
    if (!code) throw new Error('OAuth callback did not include code.');

    const redirectUri = session.redirectUri ?? localCallbackUri(req);
    const tokens = await exchangeIflowCode(code, redirectUri);
    const user = await getIflowUserInfo(tokens.accessToken);
    const providerId = upsertIflowProvider(user.apiKey, user.email, session.targetProviderId, tokens);
    oauthSessions.set(state, { status: 'complete', provider: 'iflow', createdAt, providerId, email: user.email });

    res.type('html').send('<!doctype html><html><body><script>window.close()</script><p>iFlow connected. You can close this tab.</p></body></html>');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    oauthSessions.set(state || randomBytes(8).toString('hex'), { status: 'error', provider: 'iflow', createdAt, error: message });
    res.status(400).type('html').send(`<!doctype html><html><body><p>iFlow OAuth failed: ${message}</p></body></html>`);
  }
}

oauthPublicRouter.get('/iflow/callback', (req, res) => { void handleIflowCallback(req, res); });

async function handleClaudeCallback(req: Request, res: ExpressResponse): Promise<void> {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const error = typeof req.query.error === 'string' ? req.query.error : '';
  const session = oauthSessions.get(state);
  const createdAt = session?.createdAt ?? Date.now();

  try {
    if (!session || session.provider !== 'claude' || session.status !== 'pending') throw new Error('OAuth state is invalid or expired.');
    if (error) throw new Error(error);
    if (!code) throw new Error('OAuth callback did not include code.');
    if (!session.codeVerifier) throw new Error('OAuth session is missing code verifier.');

    const redirectUri = session.redirectUri ?? localCallbackUri(req);
    const tokens = await exchangeClaudeCode(code, redirectUri, session.codeVerifier, state);
    const account = tokens.refreshToken ? `claude-${tokens.refreshToken.slice(0, 12)}` : `claude-${tokens.accessToken.slice(0, 12)}`;
    const providerId = upsertBearerProvider({
      targetProviderId: session.targetProviderId,
      provider: 'claude',
      type: 'anthropic-compatible',
      baseUrl: 'https://api.anthropic.com',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      notes: 'Connected via Claude Code OAuth',
      extraHeaders: {
        'X-Gateway-Auth-Scheme': 'bearer',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28',
        'anthropic-dangerous-direct-browser-access': 'true',
        'User-Agent': 'claude-cli/2.1.92 (external, sdk-cli)',
        'X-App': 'cli',
        'X-Stainless-Helper-Method': 'stream',
        'X-Stainless-Retry-Count': '0',
        'X-Stainless-Runtime-Version': `v${process.versions.node}`,
        'X-Stainless-Package-Version': '0.80.0',
        'X-Stainless-Runtime': 'node',
        'X-Stainless-Lang': 'js',
        'X-Stainless-Arch': process.arch === 'ia32' ? 'x86' : process.arch,
        'X-Stainless-Os': process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'MacOS' : process.platform === 'linux' ? 'Linux' : `Other::${process.platform}`,
        'X-Stainless-Timeout': '600',
      },
      cookies: { oauth_account: account, expires_in: tokens.expiresIn, scope: tokens.scope },
    });
    oauthSessions.set(state, { status: 'complete', provider: 'claude', createdAt, providerId });

    res.type('html').send('<!doctype html><html><body><script>window.close()</script><p>Claude Code connected. You can close this tab.</p></body></html>');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    oauthSessions.set(state || randomBytes(8).toString('hex'), { status: 'error', provider: 'claude', createdAt, error: message });
    res.status(400).type('html').send(`<!doctype html><html><body><p>Claude Code OAuth failed: ${message}</p></body></html>`);
  }
}

oauthPublicRouter.get('/claude/callback', (req, res) => { void handleClaudeCallback(req, res); });

async function handleClineCallback(req: Request, res: ExpressResponse): Promise<void> {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const error = typeof req.query.error === 'string' ? req.query.error : '';
  const session = oauthSessions.get(state);
  const createdAt = session?.createdAt ?? Date.now();

  try {
    if (!session || session.provider !== 'cline' || session.status !== 'pending') throw new Error('OAuth state is invalid or expired.');
    if (error) throw new Error(error);
    if (!code) throw new Error('OAuth callback did not include code.');

    const redirectUri = session.redirectUri ?? localCallbackUri(req);
    const tokens = await exchangeClineCode(code, redirectUri);
    const account = tokens.email ?? (tokens.refreshToken ? `cline-${tokens.refreshToken.slice(0, 12)}` : `cline-${tokens.accessToken.slice(0, 12)}`);
    const providerId = upsertBearerProvider({
      targetProviderId: session.targetProviderId,
      provider: 'cline',
      type: 'openai-compatible',
      baseUrl: 'https://api.cline.bot/api/v1',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      email: account,
      notes: `Connected via Cline OAuth (${account})`,
      extraHeaders: {
        'HTTP-Referer': 'https://cline.bot',
        'X-Title': 'Cline',
      },
      cookies: { expires_in: tokens.expiresIn },
    });
    oauthSessions.set(state, { status: 'complete', provider: 'cline', createdAt, providerId, email: account });

    res.type('html').send('<!doctype html><html><body><script>window.close()</script><p>Cline connected. You can close this tab.</p></body></html>');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    oauthSessions.set(state || randomBytes(8).toString('hex'), { status: 'error', provider: 'cline', createdAt, error: message });
    res.status(400).type('html').send(`<!doctype html><html><body><p>Cline OAuth failed: ${message}</p></body></html>`);
  }
}

oauthPublicRouter.get('/cline/callback', (req, res) => { void handleClineCallback(req, res); });

async function handleGoogleCallback(provider: 'gemini-cli' | 'antigravity', req: Request, res: ExpressResponse): Promise<void> {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const error = typeof req.query.error === 'string' ? req.query.error : '';
  const session = oauthSessions.get(state);
  const createdAt = session?.createdAt ?? Date.now();

  try {
    if (!session || session.provider !== provider || session.status !== 'pending') throw new Error('OAuth state is invalid or expired.');
    if (error) throw new Error(error);
    if (!code) throw new Error('OAuth callback did not include code.');
    const redirectUri = session.redirectUri ?? localCallbackUri(req);
    const tokens = await exchangeGoogleCode(provider, code, redirectUri);
    const account = tokens.email ?? `${provider}-${String(tokens.refreshToken ?? tokens.accessToken).slice(0, 12)}`;
    const providerId = upsertBearerProvider({
      targetProviderId: session.targetProviderId,
      provider,
      type: provider,
      baseUrl: provider === 'antigravity' ? 'https://daily-cloudcode-pa.googleapis.com' : 'https://cloudcode-pa.googleapis.com/v1internal',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      email: account,
      notes: `Connected via ${provider === 'antigravity' ? 'Antigravity' : 'Gemini CLI'} OAuth (${account})`,
      cookies: { project_id: tokens.projectId, expires_in: tokens.expiresIn },
    });
    oauthSessions.set(state, { status: 'complete', provider, createdAt, providerId, email: account });
    res.type('html').send(`<!doctype html><html><body><script>window.close()</script><p>${provider} connected. You can close this tab.</p></body></html>`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    oauthSessions.set(state || randomBytes(8).toString('hex'), { status: 'error', provider, createdAt, error: message });
    res.status(400).type('html').send(`<!doctype html><html><body><p>${provider} OAuth failed: ${message}</p></body></html>`);
  }
}

oauthPublicRouter.get('/gemini-cli/callback', (req, res) => { void handleGoogleCallback('gemini-cli', req, res); });
oauthPublicRouter.get('/antigravity/callback', (req, res) => { void handleGoogleCallback('antigravity', req, res); });

async function handleCodexCallback(req: Request, res: ExpressResponse): Promise<void> {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const error = typeof req.query.error === 'string' ? req.query.error : '';
  const session = oauthSessions.get(state);
  const createdAt = session?.createdAt ?? Date.now();
  try {
    if (!session || session.provider !== 'codex' || session.status !== 'pending') throw new Error('OAuth state is invalid or expired.');
    if (error) throw new Error(error);
    if (!code) throw new Error('OAuth callback did not include code.');
    if (!session.codeVerifier) throw new Error('OAuth session is missing code verifier.');
    const redirectUri = session.redirectUri ?? 'http://localhost:1455/auth/callback';
    const tokens = await exchangeCodexCode(code, redirectUri, session.codeVerifier);
    const account = tokens.email ?? `codex-${String(tokens.refreshToken ?? tokens.accessToken).slice(0, 12)}`;
    const providerId = upsertBearerProvider({
      targetProviderId: session.targetProviderId,
      provider: 'codex',
      type: 'codex',
      baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      email: account,
      notes: `Connected via Codex OAuth (${account})`,
      cookies: { id_token: tokens.idToken, expires_in: tokens.expiresIn },
    });
    oauthSessions.set(state, { status: 'complete', provider: 'codex', createdAt, providerId, email: account });
    res.type('html').send('<!doctype html><html><body><script>window.close()</script><p>Codex connected. You can close this tab.</p></body></html>');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    oauthSessions.set(state || randomBytes(8).toString('hex'), { status: 'error', provider: 'codex', createdAt, error: message });
    res.status(400).type('html').send(`<!doctype html><html><body><p>Codex OAuth failed: ${message}</p></body></html>`);
  }
}

oauthPublicRouter.get('/codex/callback', (req, res) => { void handleCodexCallback(req, res); });

async function handleGitlabCallback(req: Request, res: ExpressResponse): Promise<void> {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const error = typeof req.query.error === 'string' ? req.query.error : '';
  const session = oauthSessions.get(state);
  const createdAt = session?.createdAt ?? Date.now();
  try {
    if (!session || session.provider !== 'gitlab' || session.status !== 'pending') throw new Error('OAuth state is invalid or expired.');
    if (error) throw new Error(error);
    if (!code) throw new Error('OAuth callback did not include code.');
    if (!session.codeVerifier) throw new Error('OAuth session is missing code verifier.');
    const redirectUri = session.redirectUri ?? localCallbackUri(req);
    const tokens = await exchangeGitlabCode(code, redirectUri, session.codeVerifier);
    const account = tokens.email ?? `gitlab-${String(tokens.refreshToken ?? tokens.accessToken).slice(0, 12)}`;
    const providerId = upsertBearerProvider({
      targetProviderId: session.targetProviderId,
      provider: 'gitlab',
      type: 'gitlab',
      baseUrl: `${GITLAB_BASE_URL.replace(/\/$/, '')}/api/v4/chat/completions`,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      email: account,
      notes: `Connected via GitLab OAuth (${account})`,
      cookies: { expires_in: tokens.expiresIn },
    });
    oauthSessions.set(state, { status: 'complete', provider: 'gitlab', createdAt, providerId, email: account });
    res.type('html').send('<!doctype html><html><body><script>window.close()</script><p>GitLab connected. You can close this tab.</p></body></html>');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    oauthSessions.set(state || randomBytes(8).toString('hex'), { status: 'error', provider: 'gitlab', createdAt, error: message });
    res.status(400).type('html').send(`<!doctype html><html><body><p>GitLab OAuth failed: ${message}</p></body></html>`);
  }
}

oauthPublicRouter.get('/gitlab/callback', (req, res) => { void handleGitlabCallback(req, res); });

oauthPublicRouter.get('/callback', (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const session = oauthSessions.get(state);
  if (!session) {
    res.status(400).type('html').send('<!doctype html><html><body><p>OAuth state is invalid or expired.</p></body></html>');
    return;
  }

  switch (session.provider) {
    case 'iflow':
      void handleIflowCallback(req, res);
      return;
    case 'claude':
      void handleClaudeCallback(req, res);
      return;
    case 'cline':
      void handleClineCallback(req, res);
      return;
    case 'gemini-cli':
      void handleGoogleCallback('gemini-cli', req, res);
      return;
    case 'antigravity':
      void handleGoogleCallback('antigravity', req, res);
      return;
    case 'codex':
      void handleCodexCallback(req, res);
      return;
    case 'gitlab':
      void handleGitlabCallback(req, res);
      return;
    default:
      res.status(400).type('html').send(`<!doctype html><html><body><p>${session.provider} does not use callback OAuth.</p></body></html>`);
  }
});
