import { Buffer } from 'node:buffer';
import { db } from '../db/index.js';
import type { ProviderConfig } from './types.js';

type RefreshResult = {
  accessToken?: string;
  apiKey?: string;
  refreshToken?: string;
  expiresIn?: number;
  extraCookies?: Record<string, unknown>;
};

const CLIENTS = {
  claude: process.env.CLAUDE_OAUTH_CLIENT_ID ?? '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  codex: process.env.CODEX_OAUTH_CLIENT_ID ?? 'app_EMoamEEZ73f0CkXaXp7hrann',
  qwen: process.env.QWEN_CLIENT_ID ?? 'f0304373b74a44d2b584a3fb70ca9e56',
  gemini: {
    id: process.env.GEMINI_OAUTH_CLIENT_ID ?? '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    secret: process.env.GEMINI_OAUTH_CLIENT_SECRET ?? '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',
  },
  antigravity: {
    id: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID ?? '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    secret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET ?? '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',
  },
  kimi: process.env.KIMI_CODING_OAUTH_CLIENT_ID ?? '17e5f671-d194-4dfb-9706-5516cb48c098',
  iflow: {
    id: process.env.IFLOW_CLIENT_ID ?? '10009311001',
    secret: process.env.IFLOW_CLIENT_SECRET ?? '4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW',
  },
  gitlab: {
    baseUrl: process.env.GITLAB_BASE_URL ?? 'https://gitlab.com',
    id: process.env.GITLAB_CLIENT_ID ?? '',
    secret: process.env.GITLAB_CLIENT_SECRET ?? '',
  },
};

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function cleanCookies(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const text = str(value);
    if (text !== undefined) out[key] = text;
  }
  return out;
}

function tokenExpiryMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    return n > 10_000_000_000 ? n : n * 1000;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function expiresSoon(value: string | undefined): boolean {
  const expiry = tokenExpiryMs(value);
  if (!expiry) return true;
  return expiry - Date.now() < 5 * 60 * 1000;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(text.slice(0, 300));
  }
}

async function postForm(url: string, params: Record<string, string>, headers?: Record<string, string>): Promise<Record<string, unknown> | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers },
    body: new URLSearchParams(params),
  });
  if (!res.ok) return null;
  return readJson(res);
}

async function postJson(url: string, body: Record<string, unknown>, headers?: Record<string, string>): Promise<Record<string, unknown> | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  return readJson(res);
}

function standardResult(json: Record<string, unknown>, refreshToken: string): RefreshResult | null {
  const accessToken = str(json.access_token);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: str(json.refresh_token) ?? refreshToken,
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : undefined,
  };
}

async function refreshClaude(refreshToken: string): Promise<RefreshResult | null> {
  const json = await postJson('https://api.anthropic.com/v1/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENTS.claude,
  });
  return json ? standardResult(json, refreshToken) : null;
}

async function refreshCodex(refreshToken: string): Promise<RefreshResult | null> {
  const json = await postForm('https://auth.openai.com/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENTS.codex,
    scope: 'openid profile email',
  });
  return json ? standardResult(json, refreshToken) : null;
}

async function refreshQwen(refreshToken: string): Promise<RefreshResult | null> {
  const json = await postForm('https://chat.qwen.ai/api/v1/oauth2/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENTS.qwen,
  });
  const result = json ? standardResult(json, refreshToken) : null;
  if (!result) return null;
  const resourceUrl = str(json?.resource_url);
  return {
    ...result,
    extraCookies: {
      qwen_refresh_token: result.refreshToken,
      qwen_resource_url: resourceUrl,
    },
  };
}

async function refreshGoogle(kind: 'gemini-cli' | 'antigravity', refreshToken: string): Promise<RefreshResult | null> {
  const client = kind === 'antigravity' ? CLIENTS.antigravity : CLIENTS.gemini;
  const json = await postForm('https://oauth2.googleapis.com/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: client.id,
    client_secret: client.secret,
  });
  return json ? standardResult(json, refreshToken) : null;
}

async function refreshCline(refreshToken: string): Promise<RefreshResult | null> {
  const json = await postJson('https://api.cline.bot/api/v1/auth/refresh', {
    refreshToken,
    grantType: 'refresh_token',
    clientType: 'extension',
  });
  const data = json?.data && typeof json.data === 'object'
    ? json.data as Record<string, unknown>
    : json;
  const accessToken = str(data?.accessToken);
  if (!accessToken) return null;
  const expiresAt = str(data?.expiresAt);
  const expiresIn = expiresAt
    ? Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000))
    : undefined;
  return {
    accessToken,
    refreshToken: str(data?.refreshToken) ?? refreshToken,
    expiresIn,
    extraCookies: { expires_at: expiresAt },
  };
}

async function refreshKimi(refreshToken: string): Promise<RefreshResult | null> {
  const json = await postForm('https://auth.kimi.com/api/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENTS.kimi,
  }, {
    'X-Msh-Device-Id': `kimi-${Date.now()}`,
  });
  return json ? standardResult(json, refreshToken) : null;
}

async function refreshKiro(refreshToken: string, cookies: Record<string, string>): Promise<RefreshResult | null> {
  const clientId = cookies.client_id;
  const clientSecret = cookies.client_secret;
  if (clientId && clientSecret) {
    const region = cookies.region ?? 'us-east-1';
    const json = await postJson(`https://oidc.${region}.amazonaws.com/token`, {
      clientId,
      clientSecret,
      refreshToken,
      grantType: 'refresh_token',
    });
    const accessToken = str(json?.accessToken);
    if (!accessToken) return null;
    return {
      accessToken,
      refreshToken: str(json?.refreshToken) ?? refreshToken,
      expiresIn: typeof json?.expiresIn === 'number' ? json.expiresIn : undefined,
    };
  }

  const json = await postJson('https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken', { refreshToken }, {
    'User-Agent': 'kiro-cli/1.0.0',
  });
  const accessToken = str(json?.accessToken);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: str(json?.refreshToken) ?? refreshToken,
    expiresIn: typeof json?.expiresIn === 'number' ? json.expiresIn : undefined,
  };
}

async function getIflowApiKey(accessToken: string): Promise<{ apiKey?: string; account?: string }> {
  const res = await fetch(`https://iflow.cn/api/oauth/getUserInfo?accessToken=${encodeURIComponent(accessToken)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return {};
  const json = await readJson(res);
  const data = json.data && typeof json.data === 'object' ? json.data as Record<string, unknown> : {};
  return {
    apiKey: str(data.apiKey),
    account: str(data.email) ?? str(data.phone) ?? str(data.name),
  };
}

async function refreshIflow(refreshToken: string): Promise<RefreshResult | null> {
  const basic = Buffer.from(`${CLIENTS.iflow.id}:${CLIENTS.iflow.secret}`).toString('base64');
  const json = await postForm('https://iflow.cn/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENTS.iflow.id,
    client_secret: CLIENTS.iflow.secret,
  }, {
    Authorization: `Basic ${basic}`,
  });
  const result = json ? standardResult(json, refreshToken) : null;
  if (!result?.accessToken) return null;
  const user = await getIflowApiKey(result.accessToken);
  return {
    ...result,
    apiKey: user.apiKey ?? result.accessToken,
    extraCookies: { oauth_account: user.account },
  };
}

async function refreshGitlab(refreshToken: string): Promise<RefreshResult | null> {
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  };
  if (CLIENTS.gitlab.id) params.client_id = CLIENTS.gitlab.id;
  if (CLIENTS.gitlab.secret) params.client_secret = CLIENTS.gitlab.secret;
  const json = await postForm(`${CLIENTS.gitlab.baseUrl.replace(/\/$/, '')}/oauth/token`, params);
  return json ? standardResult(json, refreshToken) : null;
}

async function refreshCodeBuddy(refreshToken: string): Promise<RefreshResult | null> {
  const json = await postJson('https://copilot.tencent.com/v2/plugin/auth/token/refresh', { refreshToken }, {
    'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Domain': 'copilot.tencent.com',
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-Product': 'SaaS',
  });
  const data = json?.data && typeof json.data === 'object'
    ? json.data as Record<string, unknown>
    : json;
  const accessToken = str(data?.accessToken) ?? str(data?.access_token);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: str(data?.refreshToken) ?? str(data?.refresh_token) ?? refreshToken,
    expiresIn: typeof data?.expiresIn === 'number'
      ? data.expiresIn
      : typeof data?.expires_in === 'number'
        ? data.expires_in
        : 86400,
  };
}

function saveRefresh(config: ProviderConfig, provider: string, result: RefreshResult): void {
  const now = Date.now();
  const nextApiKey = result.apiKey ?? result.accessToken ?? config.apiKey;
  if (!nextApiKey) return;

  const expiresAt = result.expiresIn ? String(now + result.expiresIn * 1000) : undefined;
  const mergedCookies = cleanCookies({
    ...(config.cookies ?? {}),
    ...(result.extraCookies ?? {}),
    access_token: result.accessToken,
    oauth_access_token: result.accessToken,
    refresh_token: result.refreshToken,
    access_token_expires_at: expiresAt,
    connected_at: config.cookies?.connected_at,
    last_refreshed_at: new Date(now).toISOString(),
  });

  if (provider === 'qwen' && result.extraCookies?.qwen_resource_url) {
    const host = String(result.extraCookies.qwen_resource_url).replace(/^https?:\/\//, '').replace(/\/$/, '');
    config.baseUrl = `https://${host}/v1`;
  }

  config.apiKey = nextApiKey;
  config.cookies = mergedCookies;

  if (config.accountId) {
    db.prepare('UPDATE provider_accounts SET api_key = ?, cookies = ?, updated_at = ? WHERE id = ?')
      .run(nextApiKey, JSON.stringify(mergedCookies), now, config.accountId);
  } else {
    db.prepare('UPDATE providers SET api_key = ?, cookies = ?, updated_at = ? WHERE id = ?')
      .run(nextApiKey, JSON.stringify(mergedCookies), now, config.id);
  }
}

export async function refreshOAuthToken(config: ProviderConfig, force = false): Promise<boolean> {
  const cookies = config.cookies ?? {};
  const provider = cookies.oauth_provider;
  if (!provider || provider === 'github' || provider === 'cursor' || provider === 'kilocode') return false;

  const refreshToken = cookies.refresh_token
    ?? cookies[`${provider}_refresh_token`]
    ?? cookies.github_refresh_token
    ?? cookies.qwen_refresh_token;
  if (!refreshToken) return false;

  if (!force && !expiresSoon(cookies.access_token_expires_at)) return false;

  let result: RefreshResult | null = null;
  try {
    switch (provider) {
      case 'claude':
        result = await refreshClaude(refreshToken);
        break;
      case 'codex':
        result = await refreshCodex(refreshToken);
        break;
      case 'qwen':
        result = await refreshQwen(refreshToken);
        break;
      case 'gemini-cli':
      case 'antigravity':
        result = await refreshGoogle(provider, refreshToken);
        break;
      case 'cline':
        result = await refreshCline(refreshToken);
        break;
      case 'kimi-coding':
        result = await refreshKimi(refreshToken);
        break;
      case 'kiro':
        result = await refreshKiro(refreshToken, cookies);
        break;
      case 'iflow':
        result = await refreshIflow(refreshToken);
        break;
      case 'gitlab':
        result = await refreshGitlab(refreshToken);
        break;
      case 'codebuddy':
        result = await refreshCodeBuddy(refreshToken);
        break;
      default:
        return false;
    }
  } catch {
    return false;
  }

  if (!result?.accessToken && !result?.apiKey) return false;
  saveRefresh(config, provider, result);
  return true;
}
