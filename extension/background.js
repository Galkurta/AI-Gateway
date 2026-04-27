/**
 * AI Gateway - Background Service Worker
 * Dynamic: works with ANY provider configured in the gateway.
 */
const WEB_COOKIE_TYPES = new Set(['claude-web', 'chatgpt-web', 'bud-web', 'devin-web', 'perplexity-web', 'zenmux-web']);

/** Extract ALL cookies from a given URL/domain */
async function extractCookiesFromUrl(url) {
  const allCookies = await chrome.cookies.getAll({ url });
  const result = {};
  for (const c of allCookies) {
    result[c.name] = c.value;
  }
  return result;
}

async function extractBudAuthFromTab(tabId, tabUrl) {
  if (!tabId) return {};
  try {
    const host = new URL(tabUrl).hostname;
    if (!host.endsWith('bud.app')) return {};
  } catch {
    return {};
  }

	try {
	  const [injection] = await chrome.scripting.executeScript({
	    target: { tabId },
	    world: 'MAIN',
	    func: async () => {
	      const out = {};
	      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	      const looksJwt = value => typeof value === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
	      const rememberToken = value => {
	        if (looksJwt(value) && !out.__clerk_bearer) out.__clerk_bearer = value;
	      };
	      const rememberProjectId = value => {
	        if (typeof value === 'string' && uuidRe.test(value) && !out.bud_projectid) out.bud_projectid = value;
	      };
	      const rememberUserId = value => {
	        if (typeof value === 'string' && /^user_[A-Za-z0-9]+$/.test(value) && !out.bud_userid) out.bud_userid = value;
	      };
	      const rememberChatSessionId = value => {
	        if ((typeof value === 'string' || typeof value === 'number') && /^\d+$/.test(String(value)) && !out.bud_chatsessionid) {
	          out.bud_chatsessionid = String(value);
	        }
	      };
	      const scanUrl = href => {
	        try {
	          const url = new URL(href, location.href);
	          for (const part of url.pathname.split('/')) rememberProjectId(part);
	          rememberChatSessionId(url.searchParams.get('chatSessionId'));
	        } catch {}
	      };
	      const scanNode = node => {
	        if (node == null) return;
	        if (typeof node === 'string') {
	          rememberProjectId(node);
	          rememberUserId(node);
	          return;
	        }
	        if (Array.isArray(node)) {
	          node.forEach(scanNode);
	          return;
	        }
	        if (typeof node === 'object') {
	          for (const [key, value] of Object.entries(node)) {
	            const lower = key.toLowerCase();
	            if (lower === 'projectid' || lower === 'project_id') rememberProjectId(value);
	            if (lower === 'userid' || lower === 'user_id') rememberUserId(value);
	            if (lower === 'chatsessionid' || lower === 'chat_session_id') rememberChatSessionId(value);
	            scanNode(value);
	          }
	        }
	      };
	      const scanStoredValue = value => {
	        if (!value) return;
	        rememberToken(value);
	        scanNode(value);
	        try { scanNode(JSON.parse(value)); } catch {}
	      };
	
	      scanUrl(location.href);
	      try {
	        for (const entry of performance.getEntriesByType('resource')) {
	          if (typeof entry.name === 'string' && /bud|orchids|messages|chat-sessions/i.test(entry.name)) scanUrl(entry.name);
	        }
	      } catch {}

	      try {
	        const clerk = window.Clerk;
	        const token =
	          await clerk?.session?.getToken?.() ||
	          await clerk?.client?.sessions?.[0]?.getToken?.();
	        rememberToken(token);
	        const user = clerk?.user;
	        rememberUserId(user?.id);
	      } catch {}

	      for (const storage of [window.localStorage, window.sessionStorage]) {
	        try {
	          for (let i = 0; i < storage.length; i += 1) {
	            const key = storage.key(i);
	            if (!key) continue;
	            const value = storage.getItem(key);
	            if (!value) continue;
	            const lower = key.toLowerCase();
	            if (lower.includes('bud') || lower.includes('project') || lower.includes('user') || lower.includes('chat') || lower.includes('clerk') || lower.includes('token') || lower.includes('session')) {
	              scanStoredValue(value);
	              out[`storage_${key}`] = value;
	            }
	          }
	        } catch {}
	      }

        return out;
      },
    });
    return injection?.result && typeof injection.result === 'object' ? injection.result : {};
  } catch {
    return {};
  }
}

async function extractDevinAuthFromTab(tabId, tabUrl) {
  if (!tabId) return {};
  try {
    const host = new URL(tabUrl).hostname;
    if (host !== 'app.devin.ai') return {};
  } catch {
    return {};
  }

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        const out = {};
        const looksJwt = value => typeof value === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
        const rememberDevinToken = value => {
          if (typeof value === 'string' && value.length > 20 && !out.__devin_auth1_token) out.__devin_auth1_token = value;
        };
        const rememberAccessToken = (value, source = 'runtime') => {
          if (typeof value === 'string' && value.length > 20 && !out.__devin_bearer) {
            out.__devin_bearer = value;
            out.__devin_token_source = source;
          }
        };
        const rememberOAuthTokens = value => {
          if (!value || typeof value !== 'object') return;
          const body = value.body && typeof value.body === 'object' ? value.body : value;
          if (typeof body.access_token === 'string') {
            rememberAccessToken(body.access_token, 'auth0-localstorage');
            out.access_token = body.access_token;
            out.oauth_access_token = body.access_token;
          }
          if (typeof body.refresh_token === 'string') out.refresh_token = body.refresh_token;
          if (body.expires_in && !out.access_token_expires_at) {
            const seconds = Number(body.expires_in);
            if (Number.isFinite(seconds)) out.access_token_expires_at = String(Date.now() + seconds * 1000);
          }
          if (typeof value.expiresAt === 'number' && !out.access_token_expires_at) {
            out.access_token_expires_at = String(value.expiresAt * 1000);
          }
          if (out.refresh_token || out.access_token) {
            out.oauth_provider = 'devin';
            out.devin_auth0_domain = 'auth.devin.ai';
            out.devin_auth0_client_id = 'DjKr4B4qtVDBVMBzE4FvveclTSkJYfhk';
          }
        };
        const rememberToken = value => {
          if (looksJwt(value)) rememberAccessToken(value);
        };
        const scanValue = (value, mode = 'none') => {
          if (!value || typeof value !== 'string') return;
          if (mode === 'access') rememberToken(value);
          if (mode === 'auth1') rememberDevinToken(value);
          try {
            const parsed = JSON.parse(value);
            rememberOAuthTokens(parsed);
            const walk = node => {
              if (!node) return;
              if (typeof node === 'string') {
                if (mode === 'access') rememberToken(node);
                if (mode === 'auth1') rememberDevinToken(node);
                return;
              }
              if (Array.isArray(node)) {
                node.forEach(walk);
                return;
              }
              if (typeof node === 'object') {
                Object.values(node).forEach(walk);
              }
            };
            walk(parsed);
          } catch {}
        };

        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        for (let attempt = 0; attempt < 20 && !out.__devin_bearer; attempt += 1) {
          try {
            const getAccessToken = window.__HACK__getAccessToken || globalThis.__HACK__getAccessToken;
            if (typeof getAccessToken === 'function') {
              const token =
                await getAccessToken({ redirectOnError: false, cacheMode: attempt > 8 ? 'off' : 'on' });
              rememberAccessToken(token, 'getAccessToken');
            }
          } catch {}
          if (!out.__devin_bearer) await sleep(250);
        }

        try {
          const orgId = window.__HACK__devinOrgId || globalThis.__HACK__devinOrgId || window.__HACK__devinLatestVisitedOrgId || globalThis.__HACK__devinLatestVisitedOrgId;
          const orgName = window.__HACK__devinLatestVisitedOrgName || globalThis.__HACK__devinLatestVisitedOrgName;
          if (typeof orgId === 'string' && orgId) out.devin_orgid = orgId;
          if (typeof orgName === 'string' && orgName) out.devin_orgname = orgName;
        } catch {}

        for (const storage of [window.localStorage, window.sessionStorage]) {
          try {
            for (let i = 0; i < storage.length; i += 1) {
              const key = storage.key(i);
              if (!key) continue;
              const value = storage.getItem(key);
              if (!value) continue;
              const lower = key.toLowerCase();
              if (lower.includes('auth') || lower.includes('token') || lower.includes('session') || lower.includes('devin')) {
                out[`storage_${key}`] = value;
                scanValue(value, 'none');
                if (key === 'auth1_session') {
                  try {
                    const parsed = JSON.parse(value);
                    rememberDevinToken(parsed?.token);
                  } catch {}
                } else if (lower.includes('access') || lower.includes('bearer')) {
                  scanValue(value, 'access');
                }
              }
            }
          } catch {}
        }

        return out;
      },
    });
    return injection?.result && typeof injection.result === 'object' ? injection.result : {};
  } catch {
    return {};
  }
}

async function extractZenMuxAuthFromTab(tabId, tabUrl) {
  if (!tabId) return {};
  try {
    const host = new URL(tabUrl).hostname;
    if (host !== 'zenmux.ai' && !host.endsWith('.zenmux.ai')) return {};
  } catch {
    return {};
  }

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const out = {};
        try {
          const directCookies = Object.fromEntries(document.cookie.split(';').map(part => {
            const index = part.indexOf('=');
            if (index < 0) return ['', ''];
            return [part.slice(0, index).trim(), part.slice(index + 1)];
          }).filter(([key]) => key));
          if (directCookies.ctoken) {
            out.zenmux_ctoken = directCookies.ctoken;
            out.zenmux_csrf_token = directCookies.ctoken;
          }
        } catch {}
        const looksBearer = value =>
          typeof value === 'string' &&
          (value.startsWith('sk-') || value.startsWith('sk_') || /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value));
        const rememberToken = value => {
          if (looksBearer(value) && !out.__zenmux_bearer) out.__zenmux_bearer = value;
        };
        const scan = value => {
          if (typeof value === 'string') {
            rememberToken(value);
            try { scan(JSON.parse(value)); } catch {}
            return;
          }
          if (Array.isArray(value)) {
            value.forEach(scan);
            return;
          }
          if (value && typeof value === 'object') {
            for (const [key, nested] of Object.entries(value)) {
              const lower = key.toLowerCase();
              if (lower.includes('token') || lower.includes('apikey') || lower.includes('api_key') || lower.includes('authorization')) {
                rememberToken(nested);
                if (typeof nested === 'string' && !out[`zenmux_${lower}`]) out[`zenmux_${lower}`] = nested;
              }
              scan(nested);
            }
          }
        };

        for (const storage of [window.localStorage, window.sessionStorage]) {
          try {
            for (let i = 0; i < storage.length; i += 1) {
              const key = storage.key(i);
              if (!key) continue;
              const value = storage.getItem(key);
              if (!value) continue;
              const lower = key.toLowerCase();
              if (lower.includes('zenmux') || lower.includes('auth') || lower.includes('token') || lower.includes('api')) {
                out[`storage_${key}`] = value;
                scan(value);
              }
            }
          } catch {}
        }
        return out;
      },
    });
    return injection?.result && typeof injection.result === 'object' ? injection.result : {};
  } catch {
    return {};
  }
}

/** Push cookies to gateway for a specific provider */
async function pushCookiesToGateway(providerId, cookies, account = {}) {
  const { gatewayUrl, extensionToken } = await chrome.storage.local.get(['gatewayUrl', 'extensionToken']);
  const url = (gatewayUrl || 'http://localhost:3000').replace(/\/$/, '');
  const token = extensionToken || 'ext-token-change-me';

  if (Object.keys(cookies).length === 0) {
    return { success: false, message: 'No cookies found on this page. Make sure you are logged in.' };
  }

  try {
    const res = await fetch(`${url}/ext/cookies/${providerId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-extension-token': token },
      body: JSON.stringify({
        cookies,
        account_id: account.accountId || undefined,
        account_name: account.accountName || undefined,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { success: false, message: `Gateway ${res.status}: ${text}` };
    }
    const json = await res.json().catch(() => ({}));
    return { success: true, message: `Pushed ${Object.keys(cookies).length} cookies${json.account ? ` to ${json.account}` : ''}` };
  } catch (err) {
    return { success: false, message: `Cannot reach gateway: ${err.message}` };
  }
}

/** Fetch all providers from gateway */
async function fetchProviders() {
  const { gatewayUrl, adminPassword } = await chrome.storage.local.get(['gatewayUrl', 'adminPassword']);
  const url = (gatewayUrl || 'http://localhost:3000').replace(/\/$/, '');
  const res = await fetch(`${url}/api/providers`, {
    headers: { 'x-admin-password': adminPassword || '' },
  });
  if (!res.ok) throw new Error(`Gateway ${res.status}`);
  return res.json();
}

async function fetchProviderAccounts(providerId) {
  const { gatewayUrl, extensionToken } = await chrome.storage.local.get(['gatewayUrl', 'extensionToken']);
  const url = (gatewayUrl || 'http://localhost:3000').replace(/\/$/, '');
  const token = extensionToken || 'ext-token-change-me';
  const res = await fetch(`${url}/ext/providers/${providerId}/accounts`, {
    headers: { 'x-extension-token': token },
  });
  if (!res.ok) throw new Error(`Gateway ${res.status}`);
  return res.json();
}

function isBudUrl(url) {
  try {
    return new URL(url).hostname.endsWith('bud.app');
  } catch {
    return false;
  }
}

function isDevinUrl(url) {
  try {
    return new URL(url).hostname === 'app.devin.ai';
  } catch {
    return false;
  }
}

async function findBudTab() {
  const tabs = await chrome.tabs.query({ url: ['https://bud.app/*', 'https://*.bud.app/*'] });
  return tabs.find(tab => tab.id && tab.url) ?? null;
}

const temporaryBudAuthTabs = new Set();
const temporaryDevinAuthTabs = new Set();

function waitForTabComplete(tabId, timeoutMs = 15000, label = 'auth') {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out while opening ${label} for auth refresh.`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };

    const finishIfReady = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete' && tab.url) {
          cleanup();
          resolve(tab);
        }
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finishIfReady();
    };
    const onRemoved = removedTabId => {
      if (removedTabId === tabId) {
        cleanup();
        reject(new Error(`${label} auth tab was closed before token extraction.`));
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    finishIfReady();
  });
}

async function getBudAuthTarget({ createIfMissing = false } = {}) {
  const existing = await findBudTab();
  if (existing?.id && existing.url) return { tabId: existing.id, tabUrl: existing.url, temporary: false, kind: 'bud' };
  if (!createIfMissing) return null;

  const tab = await chrome.tabs.create({ url: 'https://bud.app/', active: false });
  if (!tab.id) throw new Error('Failed to open bud.app for auth refresh.');
  temporaryBudAuthTabs.add(tab.id);

  const loaded = await waitForTabComplete(tab.id, 15000, 'bud.app');
  if (!loaded.id || !loaded.url) throw new Error('Failed to load bud.app for auth refresh.');
  return { tabId: loaded.id, tabUrl: loaded.url, temporary: true, kind: 'bud' };
}

async function findDevinTab() {
  const tabs = await chrome.tabs.query({ url: ['https://app.devin.ai/*'] });
  return tabs.find(tab => tab.id && tab.url) ?? null;
}

async function getDevinAuthTarget({ createIfMissing = false } = {}) {
  const existing = await findDevinTab();
  if (existing?.id && existing.url) return { tabId: existing.id, tabUrl: existing.url, temporary: false, kind: 'devin' };
  if (!createIfMissing) return null;

  const tab = await chrome.tabs.create({ url: 'https://app.devin.ai/', active: false });
  if (!tab.id) throw new Error('Failed to open app.devin.ai for auth refresh.');
  temporaryDevinAuthTabs.add(tab.id);

  const loaded = await waitForTabComplete(tab.id, 30000, 'app.devin.ai');
  if (!loaded.id || !loaded.url) throw new Error('Failed to load app.devin.ai for auth refresh.');
  return { tabId: loaded.id, tabUrl: loaded.url, temporary: true, kind: 'devin' };
}

async function closeTemporaryBudTab(target) {
  if (!target?.temporary || target.kind !== 'bud' || !target.tabId) return;
  try {
    await chrome.tabs.remove(target.tabId);
  } catch {}
  temporaryBudAuthTabs.delete(target.tabId);
}

async function closeTemporaryDevinTab(target) {
  if (!target?.temporary || target.kind !== 'devin' || !target.tabId) return;
  try {
    await chrome.tabs.remove(target.tabId);
  } catch {}
  temporaryDevinAuthTabs.delete(target.tabId);
}

async function resolveExtractionTarget(providerId, tabUrl, tabId) {
  if (isBudUrl(tabUrl)) return { tabUrl, tabId };
  if (isDevinUrl(tabUrl)) return { tabUrl, tabId };

  let providers = [];
  try { providers = await fetchProviders(); } catch {}
  const provider = providers.find(p => p.id === providerId);
  if (provider?.type === 'devin-web') {
    const target = await getDevinAuthTarget({ createIfMissing: true });
    if (!target) throw new Error('Failed to open app.devin.ai for auth refresh.');
    return target;
  }
  if (provider?.type !== 'bud-web') return { tabUrl, tabId };

  const target = await getBudAuthTarget({ createIfMissing: true });
  if (!target) throw new Error('Failed to open bud.app for auth refresh.');
  return target;
}

async function extractAndPush(providerId, tabUrl, tabId, account = {}) {
  const target = await resolveExtractionTarget(providerId, tabUrl, tabId);
  try {
    const cookies = {
      ...(await extractCookiesFromUrl(target.tabUrl)),
      ...(isBudUrl(target.tabUrl) ? await extractCookiesFromUrl('https://clerk.bud.app') : {}),
      ...(isBudUrl(target.tabUrl) ? await extractCookiesFromUrl('https://accounts.bud.app') : {}),
    };
    const budAuth = await extractBudAuthFromTab(target.tabId, target.tabUrl);
    const devinAuth = await extractDevinAuthFromTab(target.tabId, target.tabUrl);
    const zenmuxAuth = await extractZenMuxAuthFromTab(target.tabId, target.tabUrl);
    return pushCookiesToGateway(providerId, { ...cookies, ...budAuth, ...devinAuth, ...zenmuxAuth }, account);
  } finally {
    await closeTemporaryBudTab(target);
    await closeTemporaryDevinTab(target);
  }
}

/** Auto-extract: when a tab finishes loading, push cookies to all matching providers */
async function handleTabUpdate(tabId, changeInfo, tab) {
  if (changeInfo.status !== 'complete' || !tab.url) return;

  const { autoExtract } = await chrome.storage.local.get('autoExtract');
  if (!autoExtract) return;

  let providers;
  try { providers = await fetchProviders(); } catch { return; }

  const tabUrl = new URL(tab.url);

  for (const p of providers) {
    if (!p.base_url || !p.enabled) continue;
    if (!WEB_COOKIE_TYPES.has(p.type)) continue;
    try {
      const providerUrl = new URL(p.base_url);
      if (providerUrl.hostname !== tabUrl.hostname) continue;
      if (p.type === 'zenmux-web') {
        await new Promise(resolve => setTimeout(resolve, 2500));
      }
      const result = await extractAndPush(p.id, tab.url, tabId);
      if (result.success) {
        chrome.action.setBadgeText({ text: '✓', tabId });
        chrome.action.setBadgeBackgroundColor({ color: '#3fb950', tabId });
        setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }).catch(() => {}), 3000);
        if (p.type === 'zenmux-web') {
          setTimeout(() => extractAndPush(p.id, tab.url, tabId).catch(() => {}), 4000);
        }
      }
    } catch { /* skip */ }
  }
}

chrome.tabs.onUpdated.addListener(handleTabUpdate);

/** Message handler for popup */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === 'EXTRACT_AND_PUSH') {
    const { providerId, tabUrl, tabId, accountId, accountName } = msg;
    extractAndPush(providerId, tabUrl, tabId, { accountId, accountName })
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, message: err.message }));
    return true;
  }

  if (msg.type === 'FETCH_PROVIDERS') {
    fetchProviders().then(providers => sendResponse({ success: true, providers }))
      .catch(err => sendResponse({ success: false, message: err.message }));
    return true;
  }

  if (msg.type === 'FETCH_PROVIDER_ACCOUNTS') {
    fetchProviderAccounts(msg.providerId).then(accounts => sendResponse({ success: true, accounts }))
      .catch(err => sendResponse({ success: false, message: err.message }));
    return true;
  }

  if (msg.type === 'GET_CURRENT_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true })
      .then(tabs => sendResponse({ tab: tabs[0] ?? null }));
    return true;
  }

  if (msg.type === 'SAVE_SETTINGS') {
    chrome.storage.local.set(msg.settings).then(() => sendResponse({ success: true }));
    return true;
  }

  if (msg.type === 'PERPLEXITY_MODEL_DETECTED') {
    if (msg.model_preference) {
      chrome.storage.local.set({
        perplexityLastModel: msg.model_preference,
        perplexityLastMode: msg.mode || 'concise',
      });
    }
    return false;
  }

  if (msg.type === 'GET_PERPLEXITY_LAST_MODEL') {
    chrome.storage.local.get(['perplexityLastModel', 'perplexityLastMode'])
      .then(data => sendResponse({ model_preference: data.perplexityLastModel || null, mode: data.perplexityLastMode || null }));
    return true;
  }

  if (msg.type === 'CHECK_GATEWAY') {
    const { gatewayUrl } = msg;
    const url = (gatewayUrl || 'http://localhost:3000').replace(/\/$/, '');
    fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })
      .then(r => sendResponse({ ok: r.ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});
