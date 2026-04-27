import { useEffect, useState } from 'react';
import { Plus, Trash2, Edit2, ToggleLeft, ToggleRight, Upload, RefreshCw, KeyRound, LogIn, Cookie, HardDrive, Users } from 'lucide-react';
import { api, type Provider, type ProviderAccount } from '../lib/api';
import { PROVIDER_PRESETS, type ProviderPreset } from '../lib/providerPresets';

// ── Type display ──────────────────────────────────────────────────────────────

const TYPE_META: Record<string, { label: string; color: string }> = {
  'anthropic':           { label: 'Anthropic API',   color: 'badge-blue'   },
  'anthropic-compatible':{ label: 'Anthropic Compat', color: 'badge-blue'  },
  'openai':              { label: 'OpenAI API',       color: 'badge-green'  },
  'openai-compatible':   { label: 'OpenAI Compat',    color: 'badge-green'  },
  'claude-web':          { label: 'Claude.ai Web',    color: 'badge-yellow' },
  'chatgpt-web':         { label: 'ChatGPT Web',      color: 'badge-yellow' },
  'bud-web':             { label: 'Bud Web',          color: 'badge-yellow' },
  'devin-web':           { label: 'Devin Web',        color: 'badge-yellow' },
  'zenmux-web':          { label: 'ZenMux Web',       color: 'badge-yellow' },
  'gemini-cli':          { label: 'Gemini CLI',       color: 'badge-blue'   },
  'antigravity':         { label: 'Antigravity',      color: 'badge-blue'   },
  'codex':               { label: 'Codex',            color: 'badge-green'  },
  'kiro':                { label: 'Kiro',             color: 'badge-yellow' },
  'cursor':              { label: 'Cursor',           color: 'badge-yellow' },
  'gitlab':              { label: 'GitLab Duo',       color: 'badge-yellow' },
  'ollama':              { label: 'Ollama',            color: 'badge-gray'   },
};

const WEB_LOGIN_TYPES = new Set(['claude-web', 'chatgpt-web', 'bud-web', 'devin-web', 'perplexity-web', 'zenmux-web']);

function isWebLoginProvider(provider: Pick<Provider, 'type'>): boolean {
  return WEB_LOGIN_TYPES.has(provider.type);
}

/** Infer provider type from base URL — used for display & backend hint */
function detectType(url: string): string {
  const u = url.toLowerCase().trim();
  if (!u)                              return 'openai-compatible';
  if (u.includes('api.anthropic.com')) return 'anthropic';
  if (u.includes('api.z.ai/api/anthropic') || u.includes('api.minimax.io/anthropic') || u.includes('api.minimaxi.com/anthropic') || u.includes('api.kimi.com/coding')) return 'anthropic-compatible';
  if (u.includes('bud.app'))           return 'bud-web';
  if (u.includes('app.devin.ai'))      return 'devin-web';
  if (u.includes('perplexity.ai') && !u.includes('api.perplexity.ai')) return 'perplexity-web';
  if (u.includes('zenmux.ai') && !u.includes('/api/')) return 'zenmux-web';
  if (u.includes('claude.ai'))         return 'claude-web';
  if (u.includes('chatgpt.com') || u.includes('chat.openai.com')) return 'chatgpt-web';
  if (u.includes('api.openai.com'))    return 'openai';
  if (u.includes('localhost:11434') || u.includes('ollama')) return 'ollama';
  return 'openai-compatible';
}

// ── Form ──────────────────────────────────────────────────────────────────────

type FormData = {
  name: string;
  provider_type: string;
  base_url: string;
  api_key: string;
  notes: string;
  preset_extra_headers: Record<string, string>;
  bud_project_id: string;
  bud_user_id: string;
  bud_chat_session_id: string;
  bud_template: string;
  devin_org_id: string;
  devin_user_id: string;
  devin_username: string;
};

type ProviderFlow = 'api-key' | 'oauth' | 'web-cookie' | 'local';

type AccountFormData = {
  name: string;
  api_key: string;
  cookies_json: string;
  priority: string;
};

const FLOW_META: Record<ProviderFlow, { label: string; hint: string; icon: typeof KeyRound }> = {
  'api-key': { label: 'API Key', hint: 'Standard API providers', icon: KeyRound },
  oauth: { label: 'OAuth Login', hint: 'Browser or device-code login', icon: LogIn },
  'web-cookie': { label: 'Web Login', hint: 'Website login + session import', icon: Cookie },
  local: { label: 'Local', hint: 'Local runtime providers', icon: HardDrive },
};

const emptyForm = (): FormData => ({
  name: '',
  provider_type: '',
  base_url: '',
  api_key: '',
  notes: '',
  preset_extra_headers: {},
  bud_project_id: '',
  bud_user_id: '',
  bud_chat_session_id: '',
  bud_template: 'nextjs',
  devin_org_id: '',
  devin_user_id: '',
  devin_username: '',
});

const emptyAccountForm = (): AccountFormData => ({
  name: '',
  api_key: '',
  cookies_json: '',
  priority: '0',
});

// ── Component ─────────────────────────────────────────────────────────────────

export default function ProvidersPage() {
  const [providers, setProviders]       = useState<Provider[]>([]);
  const [showForm, setShowForm]         = useState(false);
  const [editId, setEditId]             = useState<string | null>(null);
  const [form, setForm]                 = useState<FormData>(emptyForm());
  const [loading, setLoading]           = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [selectedFlow, setSelectedFlow] = useState<ProviderFlow>('api-key');
  const [oauthMsg, setOauthMsg]         = useState('');
  const [cookieProviderId, setCookieProviderId] = useState('');
  const [cookieJson, setCookieJson]     = useState('');
  const [cookieMsg, setCookieMsg]       = useState('');
  const [expandedProviderId, setExpandedProviderId] = useState('');
  const [accountsByProvider, setAccountsByProvider] = useState<Record<string, ProviderAccount[]>>({});
  const [accountForms, setAccountForms] = useState<Record<string, AccountFormData>>({});
  const [accountOAuthPresetByProvider, setAccountOAuthPresetByProvider] = useState<Record<string, string>>({});
  const [accountOAuthMsg, setAccountOAuthMsg] = useState<Record<string, string>>({});
  const [accountOAuthLoading, setAccountOAuthLoading] = useState<Record<string, boolean>>({});

  const load = () => api.providers.list().then(setProviders).catch(console.error);
  useEffect(() => { load(); }, []);

  async function loadAccounts(providerId: string) {
    const rows = await api.providers.accounts.list(providerId);
    setAccountsByProvider(prev => ({ ...prev, [providerId]: rows }));
  }

  async function toggleAccounts(providerId: string) {
    const next = expandedProviderId === providerId ? '' : providerId;
    setExpandedProviderId(next);
    if (next) {
      setAccountForms(prev => ({ ...prev, [providerId]: prev[providerId] ?? emptyAccountForm() }));
      await loadAccounts(providerId);
    }
  }

  const detectedType = form.provider_type || detectType(form.base_url);
  const isCookieBased = WEB_LOGIN_TYPES.has(detectedType);
  const selectedPreset = PROVIDER_PRESETS.find(p => p.id === selectedPresetId);
  const isOAuthPreset = !!selectedPreset?.oauth;
  const flowPresets = PROVIDER_PRESETS.filter(p => (p.flow ?? 'api-key') === selectedFlow);

  function applyPreset(presetId: string) {
    setSelectedPresetId(presetId);
    setOauthMsg('');
    const preset = PROVIDER_PRESETS.find(p => p.id === presetId);
    if (!preset) return;
    setForm(f => ({
      ...f,
      name: f.name || preset.name,
      provider_type: preset.type,
      base_url: preset.base_url,
      notes: f.notes || preset.notes || '',
      preset_extra_headers: preset.extra_headers ?? {},
    }));
  }

  function oauthLabel(provider: NonNullable<ProviderPreset['oauth']>): string {
    switch (provider) {
      case 'iflow': return 'iFlow';
      case 'qwen': return 'Qwen';
      case 'claude': return 'Claude Code';
      case 'gemini-cli': return 'Gemini CLI';
      case 'antigravity': return 'Antigravity';
      case 'codex': return 'Codex';
      case 'kiro': return 'Kiro';
      case 'github': return 'GitHub Copilot';
      case 'kimi-coding': return 'Kimi Coding';
      case 'kilocode': return 'KiloCode';
      case 'codebuddy': return 'CodeBuddy';
      case 'cline': return 'Cline';
      case 'gitlab': return 'GitLab Duo';
    }
  }

  function oauthPresetsForProvider(provider: Provider): ProviderPreset[] {
    const baseUrl = (provider.base_url ?? '').replace(/\/$/, '');
    return PROVIDER_PRESETS.filter(preset =>
      preset.oauth && preset.base_url.replace(/\/$/, '') === baseUrl
    );
  }

  async function connectOAuth() {
    const oauthProvider = selectedPreset?.oauth;
    if (!oauthProvider) return;
    const label = oauthLabel(oauthProvider);
    setLoading(true);
    setOauthMsg(`Opening ${label} login...`);
    try {
      const started = await api.oauth.start(oauthProvider);
      const popup = window.open(started.authUrl, `ai-gateway-${oauthProvider}-oauth`, 'width=520,height=760');
      if (!popup) {
        setOauthMsg('Popup blocked. Allow popups and try again.');
        setLoading(false);
        return;
      }

      setOauthMsg(started.userCode
        ? `Enter code ${started.userCode} in the opened ${label} page.`
        : `Waiting for ${label} authorization...`);
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const status = await api.oauth.status(oauthProvider, started.state);
        if (status.status === 'complete') {
          setOauthMsg(`Connected${status.email ? `: ${status.email}` : ''}`);
          setShowForm(false);
          setEditId(null);
          setForm(emptyForm());
          setSelectedPresetId('');
          load();
          setTimeout(() => setOauthMsg(''), 3000);
          setLoading(false);
          return;
        }
        if (status.status === 'error') throw new Error(status.error);
      }
      throw new Error('OAuth timeout.');
    } catch (e) {
      setOauthMsg(`OAuth error: ${e instanceof Error ? e.message : String(e)}`);
      setLoading(false);
    }
  }

  async function connectOAuthAccount(provider: Provider) {
    const presets = oauthPresetsForProvider(provider);
    const presetId = accountOAuthPresetByProvider[provider.id] || presets[0]?.id;
    const oauthProvider = PROVIDER_PRESETS.find(p => p.id === presetId)?.oauth;
    if (!oauthProvider) return;
    const label = oauthLabel(oauthProvider);
    setAccountOAuthLoading(prev => ({ ...prev, [provider.id]: true }));
    setAccountOAuthMsg(prev => ({ ...prev, [provider.id]: `Opening ${label} login...` }));
    try {
      const started = await api.oauth.start(oauthProvider, provider.id);
      const popup = window.open(started.authUrl, `ai-gateway-${oauthProvider}-account-oauth`, 'width=520,height=760');
      if (!popup) {
        setAccountOAuthMsg(prev => ({ ...prev, [provider.id]: 'Popup blocked. Allow popups and try again.' }));
        setAccountOAuthLoading(prev => ({ ...prev, [provider.id]: false }));
        return;
      }

      setAccountOAuthMsg(prev => ({
        ...prev,
        [provider.id]: started.userCode
          ? `Enter code ${started.userCode} in the opened ${label} page.`
          : `Waiting for ${label} authorization...`,
      }));
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const status = await api.oauth.status(oauthProvider, started.state);
        if (status.status === 'complete') {
          setAccountOAuthMsg(prev => ({ ...prev, [provider.id]: `Account connected${status.email ? `: ${status.email}` : ''}` }));
          await loadAccounts(provider.id);
          load();
          setTimeout(() => setAccountOAuthMsg(prev => ({ ...prev, [provider.id]: '' })), 3000);
          setAccountOAuthLoading(prev => ({ ...prev, [provider.id]: false }));
          return;
        }
        if (status.status === 'error') throw new Error(status.error);
      }
      throw new Error('OAuth timeout.');
    } catch (e) {
      setAccountOAuthMsg(prev => ({ ...prev, [provider.id]: `OAuth error: ${e instanceof Error ? e.message : String(e)}` }));
      setAccountOAuthLoading(prev => ({ ...prev, [provider.id]: false }));
    }
  }

  async function save() {
    setLoading(true);
    try {
      const extra_headers = (() => {
        const presetHeaders = form.preset_extra_headers;
        if (detectedType === 'bud-web') return {
            ...presetHeaders,
            ...(form.bud_project_id ? { 'X-Bud-ProjectId': form.bud_project_id } : {}),
            ...(form.bud_user_id ? { 'X-Bud-UserId': form.bud_user_id } : {}),
            ...(form.bud_chat_session_id ? { 'X-Bud-ChatSessionId': form.bud_chat_session_id } : {}),
            ...(form.bud_template ? { 'X-Bud-Template': form.bud_template } : {}),
          };
        if (detectedType === 'devin-web') return {
            ...presetHeaders,
            ...(form.devin_org_id ? { 'X-Devin-OrgId': form.devin_org_id } : {}),
            ...(form.devin_user_id ? { 'X-Devin-UserId': form.devin_user_id } : {}),
            ...(form.devin_username ? { 'X-Devin-Username': form.devin_username } : {}),
          };
        return Object.keys(presetHeaders).length ? presetHeaders : undefined;
      })();
      const payload = {
        name:     form.name,
        base_url: form.base_url || undefined,
        api_key:  form.api_key  || undefined,
        notes:    form.notes    || undefined,
        extra_headers,
        // send detected type so backend doesn't have to guess
        type:     detectedType,
      };
      if (editId) await api.providers.update(editId, payload);
      else        await api.providers.create(payload);
      setShowForm(false); setEditId(null); setForm(emptyForm());
      load();
    } catch (e) { alert(String(e)); }
    setLoading(false);
  }

  async function toggle(p: Provider) {
    await api.providers.update(p.id, { enabled: (p.enabled ? 0 : 1) as unknown as number });
    load();
  }

  async function remove(id: string) {
    if (!confirm('Delete this provider?')) return;
    await api.providers.delete(id); load();
  }

  async function addAccount(providerId: string) {
    const form = accountForms[providerId] ?? emptyAccountForm();
    let cookies: object | undefined;
    if (form.cookies_json.trim()) {
      try {
        cookies = JSON.parse(form.cookies_json);
      } catch {
        alert('Cookies must be valid JSON.');
        return;
      }
    }
    await api.providers.accounts.create(providerId, {
      name: form.name || 'Account',
      api_key: form.api_key || undefined,
      cookies,
      priority: Number.parseInt(form.priority, 10) || 0,
      enabled: true,
    });
    setAccountForms(prev => ({ ...prev, [providerId]: emptyAccountForm() }));
    await loadAccounts(providerId);
    load();
  }

  async function toggleAccount(providerId: string, account: ProviderAccount) {
    await api.providers.accounts.update(providerId, account.id, { enabled: !account.enabled });
    await loadAccounts(providerId);
    load();
  }

  async function deleteAccount(providerId: string, accountId: string) {
    if (!confirm('Delete this account?')) return;
    await api.providers.accounts.delete(providerId, accountId);
    await loadAccounts(providerId);
    load();
  }

  function startEdit(p: Provider) {
    let extra: Record<string, string> = {};
    try {
      if (p.extra_headers && p.extra_headers !== '[configured]') extra = JSON.parse(p.extra_headers);
    } catch {
      extra = {};
    }
    setForm({
      name: p.name,
      provider_type: p.type,
      base_url: p.base_url ?? '',
      api_key: '',
      notes: p.notes ?? '',
      preset_extra_headers: extra,
      bud_project_id: extra['X-Bud-ProjectId'] ?? '',
      bud_user_id: extra['X-Bud-UserId'] ?? '',
      bud_chat_session_id: extra['X-Bud-ChatSessionId'] ?? '',
      bud_template: extra['X-Bud-Template'] ?? 'nextjs',
      devin_org_id: extra['X-Devin-OrgId'] ?? '',
      devin_user_id: extra['X-Devin-UserId'] ?? '',
      devin_username: extra['X-Devin-Username'] ?? '',
    });
    setSelectedPresetId('');
    setOauthMsg('');
    setEditId(p.id); setShowForm(true);
  }

  async function submitCookies() {
    try {
      const parsed = JSON.parse(cookieJson);
      await api.providers.updateCookies(cookieProviderId, parsed);
      setCookieMsg('Cookies updated!'); setCookieJson('');
      setTimeout(() => setCookieMsg(''), 3000);
    } catch (e) { setCookieMsg(`Error: ${String(e)}`); }
  }

  const webProviders = providers.filter(isWebLoginProvider);

  const oauthCount = providers.filter(p => !isWebLoginProvider(p) && p.auth_type === 'oauth').length;
  const webLoginCount = webProviders.length;
  const keyCount = providers.filter(p => p.api_key && p.auth_type !== 'oauth').length;
  const enabledCount = providers.filter(p => p.enabled).length;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,4fr)_minmax(16rem,1fr)] gap-6 max-w-7xl">
      <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-300">{providers.length} provider(s)</h2>
        <div className="flex gap-2">
          <button className="btn-ghost flex items-center gap-1.5" onClick={load}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button className="btn-primary flex items-center gap-1.5"
            onClick={() => { setShowForm(true); setEditId(null); setForm(emptyForm()); setSelectedPresetId(''); setSelectedFlow('api-key'); setOauthMsg(''); }}>
            <Plus size={14} /> Add Provider
          </button>
        </div>
      </div>

      {/* Provider list */}
      <div className="space-y-2">
        {providers.length === 0 && (
          <div className="card text-center text-muted text-sm py-12">
            No providers yet. Add one to get started.
          </div>
        )}
        {providers.map(p => {
          const meta = TYPE_META[p.type] ?? { label: p.type, color: 'badge-gray' };
          const accounts = accountsByProvider[p.id] ?? [];
          const accountForm = accountForms[p.id] ?? emptyAccountForm();
          const expanded = expandedProviderId === p.id;
          const oauthAccountPresets = oauthPresetsForProvider(p);
          const selectedAccountOAuthPreset = accountOAuthPresetByProvider[p.id] || oauthAccountPresets[0]?.id || '';
          return (
            <div key={p.id} className={`card space-y-3 ${!p.enabled ? 'opacity-50' : ''}`}>
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-100">{p.name}</span>
                    <span className={meta.color}>{meta.label}</span>
                    {isWebLoginProvider(p) && <span className="badge-yellow">Web Login</span>}
                    {!isWebLoginProvider(p) && p.auth_type === 'oauth' && <span className="badge-blue">OAuth</span>}
                    {!isWebLoginProvider(p) && p.auth_type === 'cookies' && <span className="badge-yellow">Cookies</span>}
                    {p.api_key && p.auth_type !== 'oauth' && <span className="badge-gray">Key</span>}
                    <span className="badge-gray">{p.enabled_account_count ?? 0}/{p.account_count ?? 0} accounts</span>
                  </div>
                  {p.base_url && (
                    <p className="text-xs text-muted mt-0.5 font-mono truncate">{p.base_url}</p>
                  )}
                  {p.notes && <p className="text-xs text-muted mt-0.5">{p.notes}</p>}
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button className="btn-ghost p-1.5" title="Accounts" onClick={() => toggleAccounts(p.id)}>
                    <Users size={14} className={expanded ? 'text-accent' : ''} />
                  </button>
                  <button className="btn-ghost p-1.5" onClick={() => toggle(p)}>
                    {p.enabled
                      ? <ToggleRight size={18} className="text-success" />
                      : <ToggleLeft  size={18} />}
                  </button>
                  <button className="btn-ghost p-1.5" onClick={() => startEdit(p)}>
                    <Edit2 size={14} />
                  </button>
                  <button className="btn-danger p-1.5" onClick={() => remove(p.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              {expanded && (
                <div className="border-t border-border pt-3 space-y-3">
                  <div className="space-y-1.5">
                    {accounts.length === 0 && <p className="text-xs text-muted">No accounts configured.</p>}
                    {accounts.map(account => (
                      <div key={account.id} className="bg-base-700 rounded px-3 py-2 flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-medium text-gray-200">{account.name}</span>
                            <span className={isWebLoginProvider(p) ? 'badge-yellow' : account.auth_type === 'oauth' ? 'badge-blue' : account.auth_type === 'cookies' ? 'badge-yellow' : 'badge-gray'}>
                              {isWebLoginProvider(p) ? 'web login' : account.auth_type ?? 'key'}
                            </span>
                            {account.enabled ? <span className="badge-green">Active</span> : <span className="badge-gray">Disabled</span>}
                          </div>
                          <p className="text-[11px] text-muted font-mono truncate">
                            {account.api_key ? account.api_key : account.cookies ? 'cookies configured' : 'no credential'} · {account.requests_count} requests
                          </p>
                        </div>
                        <button className="btn-ghost p-1.5" onClick={() => toggleAccount(p.id, account)}>
                          {account.enabled ? <ToggleRight size={16} className="text-success" /> : <ToggleLeft size={16} />}
                        </button>
                        <button className="btn-danger p-1.5" onClick={() => deleteAccount(p.id, account.id)}>
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>

                  {oauthAccountPresets.length > 0 && (
                    <div className="grid grid-cols-12 gap-2 items-center">
                      <select
                        className="input col-span-8"
                        value={selectedAccountOAuthPreset}
                        onChange={e => setAccountOAuthPresetByProvider(prev => ({ ...prev, [p.id]: e.target.value }))}
                      >
                        {oauthAccountPresets.map(preset => (
                          <option key={preset.id} value={preset.id}>{preset.name}</option>
                        ))}
                      </select>
                      <button
                        className="btn-primary col-span-4 px-2"
                        disabled={!!accountOAuthLoading[p.id]}
                        onClick={() => connectOAuthAccount(p)}
                      >
                        {accountOAuthLoading[p.id] ? 'Connecting...' : 'Add OAuth Account'}
                      </button>
                      {accountOAuthMsg[p.id] && (
                        <p className={`col-span-12 text-xs ${accountOAuthMsg[p.id].startsWith('OAuth error') ? 'text-danger' : 'text-muted'}`}>
                          {accountOAuthMsg[p.id]}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-12 gap-2">
                    <input
                      className="input col-span-3"
                      placeholder="Account name"
                      value={accountForm.name}
                      onChange={e => setAccountForms(prev => ({ ...prev, [p.id]: { ...accountForm, name: e.target.value } }))}
                    />
                    <input
                      className="input col-span-4 font-mono"
                      type="password"
                      placeholder="API key"
                      value={accountForm.api_key}
                      onChange={e => setAccountForms(prev => ({ ...prev, [p.id]: { ...accountForm, api_key: e.target.value } }))}
                    />
                    <input
                      className="input col-span-3 font-mono"
                      placeholder='Cookies JSON'
                      value={accountForm.cookies_json}
                      onChange={e => setAccountForms(prev => ({ ...prev, [p.id]: { ...accountForm, cookies_json: e.target.value } }))}
                    />
                    <input
                      className="input col-span-1"
                      placeholder="Prio"
                      value={accountForm.priority}
                      onChange={e => setAccountForms(prev => ({ ...prev, [p.id]: { ...accountForm, priority: e.target.value } }))}
                    />
                    <button className="btn-primary col-span-1 px-2" onClick={() => addAccount(p.id)}>
                      <Plus size={14} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add / Edit modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="card w-full max-w-lg space-y-4">
            <h3 className="text-sm font-medium">{editId ? 'Edit Provider' : 'Add Provider'}</h3>

            {!editId && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  {(Object.entries(FLOW_META) as [ProviderFlow, typeof FLOW_META[ProviderFlow]][]).map(([flow, meta]) => {
                    const Icon = meta.icon;
                    const active = selectedFlow === flow;
                    return (
                      <button
                        key={flow}
                        type="button"
                        className={`border rounded px-3 py-2 text-left transition ${active ? 'border-accent bg-accent/10' : 'border-border bg-base-700 hover:border-gray-600'}`}
                        onClick={() => {
                          setSelectedFlow(flow);
                          setSelectedPresetId('');
                          setForm(emptyForm());
                          setOauthMsg('');
                        }}
                      >
                        <span className="flex items-center gap-2 text-xs font-medium text-gray-100">
                          <Icon size={14} /> {meta.label}
                        </span>
                        <span className="block text-[11px] text-muted mt-1 leading-snug">{meta.hint}</span>
                      </button>
                    );
                  })}
                </div>
                <label className="text-xs text-muted mb-1 block">Provider</label>
                <select
                  className="input"
                  value={selectedPresetId}
                  onChange={e => applyPreset(e.target.value)}
                >
                  <option value="">Choose {FLOW_META[selectedFlow].label.toLowerCase()} provider...</option>
                  {flowPresets.map((preset: ProviderPreset) => (
                    <option key={preset.id} value={preset.id}>{preset.name}</option>
                  ))}
                </select>
              </div>
            )}

            {selectedPreset?.oauth && (
              <div className="border border-border rounded p-3 space-y-2">
                <p className="text-xs text-muted">
                  Login OAuth will create or update this provider automatically. No API key paste is needed.
                </p>
                {selectedPreset.notes && (
                  <p className="text-xs text-muted">{selectedPreset.notes}</p>
                )}
                <button className="btn-primary w-full" disabled={loading} onClick={connectOAuth}>
                  {loading ? 'Connecting...' : `Login with ${oauthLabel(selectedPreset.oauth)}`}
                </button>
                {oauthMsg && (
                  <p className={`text-xs ${oauthMsg.startsWith('OAuth error') ? 'text-danger' : 'text-muted'}`}>{oauthMsg}</p>
                )}
              </div>
            )}

            {/* Name */}
            <div>
              <label className="text-xs text-muted mb-1 block">Name *</label>
              <input
                className="input"
                placeholder="Provider name"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>

            {/* Base URL + auto-detected type badge */}
            <div>
              <label className="text-xs text-muted mb-1 block">
                Base URL
                <span className="text-gray-500 ml-1">(leave blank for Anthropic / OpenAI default)</span>
              </label>
              <input
                className="input font-mono"
                placeholder="https://..."
                value={form.base_url}
                onChange={e => setForm(f => ({ ...f, base_url: e.target.value }))}
              />
            </div>

            {/* API Key — hidden for cookie-based */}
            {!isCookieBased && !isOAuthPreset && (
              <div>
                <label className="text-xs text-muted mb-1 block">
                  API Key
                  {editId && <span className="text-gray-500 ml-1">(blank = keep existing)</span>}
                </label>
                <input
                  className="input font-mono"
                  type="password"
                  placeholder="Enter API key"
                  value={form.api_key}
                  onChange={e => setForm(f => ({ ...f, api_key: e.target.value }))}
                />
              </div>
            )}

            {isCookieBased && (
              <p className="text-xs text-warning bg-warning/10 border border-warning/20 rounded px-3 py-2">
                Web login provider - create it, log in on the provider website, then use the Chrome Extension or Cookie Injection panel to import the session.
              </p>
            )}

            {detectedType === 'bud-web' && (
              <div className="space-y-3 border border-border rounded p-3">
                <div>
                  <label className="text-xs text-muted mb-1 block">Bud Project ID *</label>
                  <input
                    className="input font-mono"
                    placeholder="8fdbdaea-dad7-408c-849d-cd0895f7e67a"
                    value={form.bud_project_id}
                    onChange={e => setForm(f => ({ ...f, bud_project_id: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted mb-1 block">Bud User ID *</label>
                  <input
                    className="input font-mono"
                    placeholder="user_..."
                    value={form.bud_user_id}
                    onChange={e => setForm(f => ({ ...f, bud_user_id: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted mb-1 block">Bud Chat Session ID</label>
                  <input
                    className="input font-mono"
                    placeholder="12673"
                    value={form.bud_chat_session_id}
                    onChange={e => setForm(f => ({ ...f, bud_chat_session_id: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted mb-1 block">Bud Template</label>
                  <input
                    className="input font-mono"
                    placeholder="nextjs"
                    value={form.bud_template}
                    onChange={e => setForm(f => ({ ...f, bud_template: e.target.value }))}
                  />
                </div>
              </div>
            )}

            {detectedType === 'devin-web' && (
              <div className="space-y-3 border border-border rounded p-3">
                <div>
                  <label className="text-xs text-muted mb-1 block">Devin Org ID</label>
                  <input
                    className="input font-mono"
                    placeholder="org-..."
                    value={form.devin_org_id}
                    onChange={e => setForm(f => ({ ...f, devin_org_id: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted mb-1 block">Devin User ID</label>
                  <input
                    className="input font-mono"
                    placeholder="user-..."
                    value={form.devin_user_id}
                    onChange={e => setForm(f => ({ ...f, devin_user_id: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted mb-1 block">Devin Username</label>
                  <input
                    className="input font-mono"
                    placeholder="Gal"
                    value={form.devin_username}
                    onChange={e => setForm(f => ({ ...f, devin_username: e.target.value }))}
                  />
                </div>
              </div>
            )}

            {/* Notes */}
            <div>
              <label className="text-xs text-muted mb-1 block">Notes <span className="text-gray-600">(optional)</span></label>
              <input
                className="input"
                placeholder="Optional notes"
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              />
            </div>

            <div className="flex gap-2 justify-end pt-1">
              <button className="btn-ghost" onClick={() => { setShowForm(false); setEditId(null); setSelectedPresetId(''); setOauthMsg(''); }}>
                Cancel
              </button>
              {!isOAuthPreset && (
                <button className="btn-primary" disabled={loading || !form.name} onClick={save}>
                  {loading ? 'Saving…' : editId ? 'Update' : 'Create'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Cookie injector (shown only when web providers exist) */}
      {webProviders.length > 0 && (
        <div className="card space-y-3">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Upload size={14} className="text-warning" /> Manual Cookie Injection
          </h3>
          <p className="text-xs text-muted">
            Paste cookies as JSON. Or use the Chrome Extension for automatic extraction.
          </p>
          <select className="input" value={cookieProviderId} onChange={e => setCookieProviderId(e.target.value)}>
            <option value="">Select provider…</option>
            {webProviders.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <textarea
            className="input h-28 resize-none font-mono text-xs"
            placeholder={'{\n  "sessionKey": "sk-ant-...",\n  "cf_clearance": "..."\n}'}
            value={cookieJson}
            onChange={e => setCookieJson(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <button
              className="btn-primary flex items-center gap-1.5"
              disabled={!cookieProviderId || !cookieJson}
              onClick={submitCookies}
            >
              <Upload size={14} /> Inject Cookies
            </button>
            {cookieMsg && (
              <span className={`text-xs ${cookieMsg.startsWith('Error') ? 'text-danger' : 'text-success'}`}>
                {cookieMsg}
              </span>
            )}
          </div>
        </div>
      )}
      </div>

      <aside className="space-y-3">
        <div className="card space-y-3">
          <h3 className="text-sm font-medium">Provider Summary</h3>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="bg-base-700 rounded p-3">
              <p className="text-muted">Enabled</p>
              <p className="text-lg text-gray-100 mt-1">{enabledCount}</p>
            </div>
            <div className="bg-base-700 rounded p-3">
              <p className="text-muted">OAuth</p>
              <p className="text-lg text-accent mt-1">{oauthCount}</p>
            </div>
            <div className="bg-base-700 rounded p-3">
              <p className="text-muted">API Key</p>
              <p className="text-lg text-success mt-1">{keyCount}</p>
            </div>
            <div className="bg-base-700 rounded p-3">
              <p className="text-muted">Web Login</p>
              <p className="text-lg text-warning mt-1">{webLoginCount}</p>
            </div>
          </div>
        </div>

        <div className="card space-y-2">
          <h3 className="text-sm font-medium">Flow Guide</h3>
          <p className="text-xs text-muted">OAuth is for gateway/device-code login flows. Web Login is for website adapters such as ZenMux, Bud, and Devin.</p>
          <p className="text-xs text-muted">API Key providers are the most stable choice for VPS deployments.</p>
        </div>
      </aside>
    </div>
  );
}
