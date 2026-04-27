export type ProviderPreset = {
  id: string;
  name: string;
  type: string;
  base_url: string;
  flow?: 'api-key' | 'oauth' | 'web-cookie' | 'local';
  notes?: string;
  extra_headers?: Record<string, string>;
  oauth?: 'iflow' | 'qwen' | 'github' | 'kimi-coding' | 'kilocode' | 'codebuddy' | 'claude' | 'cline' | 'gemini-cli' | 'antigravity' | 'codex' | 'kiro' | 'gitlab';
};

export const PROVIDER_PRESETS: ProviderPreset[] = ([
  { id: 'openai', name: 'OpenAI', type: 'openai', base_url: 'https://api.openai.com', flow: 'api-key' },
  { id: 'anthropic', name: 'Anthropic', type: 'anthropic', base_url: 'https://api.anthropic.com', flow: 'api-key' },
  { id: 'openrouter', name: 'OpenRouter', type: 'openai-compatible', base_url: 'https://openrouter.ai/api/v1', extra_headers: { 'HTTP-Referer': 'http://localhost:3000', 'X-Title': 'AI Gateway' } },
  { id: 'xai', name: 'xAI / Grok', type: 'openai-compatible', base_url: 'https://api.x.ai/v1' },
  { id: 'groq', name: 'Groq', type: 'openai-compatible', base_url: 'https://api.groq.com/openai/v1' },
  { id: 'deepseek', name: 'DeepSeek', type: 'openai-compatible', base_url: 'https://api.deepseek.com/chat/completions' },
  { id: 'mistral', name: 'Mistral', type: 'openai-compatible', base_url: 'https://api.mistral.ai/v1' },
  { id: 'perplexity', name: 'Perplexity', type: 'openai-compatible', base_url: 'https://api.perplexity.ai/chat/completions' },
  { id: 'together', name: 'Together AI', type: 'openai-compatible', base_url: 'https://api.together.xyz/v1' },
  { id: 'fireworks', name: 'Fireworks AI', type: 'openai-compatible', base_url: 'https://api.fireworks.ai/inference/v1' },
  { id: 'cerebras', name: 'Cerebras', type: 'openai-compatible', base_url: 'https://api.cerebras.ai/v1' },
  { id: 'cohere', name: 'Cohere', type: 'openai-compatible', base_url: 'https://api.cohere.ai/v1' },
  { id: 'nvidia', name: 'NVIDIA NIM', type: 'openai-compatible', base_url: 'https://integrate.api.nvidia.com/v1' },
  { id: 'nebius', name: 'Nebius AI Studio', type: 'openai-compatible', base_url: 'https://api.studio.nebius.ai/v1' },
  { id: 'siliconflow', name: 'SiliconFlow', type: 'openai-compatible', base_url: 'https://api.siliconflow.cn/v1' },
  { id: 'hyperbolic', name: 'Hyperbolic', type: 'openai-compatible', base_url: 'https://api.hyperbolic.xyz/v1' },
  { id: 'chutes', name: 'Chutes AI', type: 'openai-compatible', base_url: 'https://llm.chutes.ai/v1' },
  { id: 'qwen-dashscope-intl', name: 'Qwen DashScope Intl', type: 'openai-compatible', base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
  { id: 'qwen-dashscope-cn', name: 'Qwen DashScope China', type: 'openai-compatible', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'qwen-oauth', name: 'Qwen OAuth', type: 'openai-compatible', base_url: 'https://portal.qwen.ai/v1', flow: 'oauth', oauth: 'qwen', notes: 'Qwen OAuth was marked deprecated by 9router on 2026-04-15; existing accounts may still work.' },
  { id: 'iflow-oauth', name: 'iFlow OAuth', type: 'openai-compatible', base_url: 'https://apis.iflow.cn/v1', extra_headers: { 'User-Agent': 'iFlow-Cli' }, oauth: 'iflow' },
  { id: 'claude-code-oauth', name: 'Claude Code OAuth', type: 'anthropic-compatible', base_url: 'https://api.anthropic.com', oauth: 'claude' },
  { id: 'gemini-cli-oauth', name: 'Gemini CLI OAuth', type: 'gemini-cli', base_url: 'https://cloudcode-pa.googleapis.com/v1internal', oauth: 'gemini-cli' },
  { id: 'antigravity-oauth', name: 'Antigravity OAuth', type: 'antigravity', base_url: 'https://daily-cloudcode-pa.googleapis.com', oauth: 'antigravity' },
  { id: 'codex-oauth', name: 'Codex OAuth', type: 'codex', base_url: 'https://chatgpt.com/backend-api/codex/responses', oauth: 'codex' },
  { id: 'kiro-oauth', name: 'Kiro OAuth', type: 'kiro', base_url: 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse', oauth: 'kiro' },
  { id: 'github-copilot-oauth', name: 'GitHub Copilot OAuth', type: 'openai-compatible', base_url: 'https://api.githubcopilot.com/chat/completions', oauth: 'github' },
  { id: 'kimi-coding-oauth', name: 'Kimi Coding OAuth', type: 'anthropic-compatible', base_url: 'https://api.kimi.com/coding', oauth: 'kimi-coding' },
  { id: 'kilocode-oauth', name: 'KiloCode OAuth', type: 'openai-compatible', base_url: 'https://api.kilo.ai/api/openrouter/chat/completions', oauth: 'kilocode' },
  { id: 'codebuddy-oauth', name: 'CodeBuddy OAuth', type: 'openai-compatible', base_url: 'https://copilot.tencent.com/v1', oauth: 'codebuddy' },
  { id: 'cline-oauth', name: 'Cline OAuth', type: 'openai-compatible', base_url: 'https://api.cline.bot/api/v1', oauth: 'cline' },
  { id: 'gitlab-oauth', name: 'GitLab Duo OAuth', type: 'gitlab', base_url: 'https://gitlab.com/api/v4/chat/completions', oauth: 'gitlab', notes: 'Requires GITLAB_CLIENT_ID in server/.env.' },
  { id: 'cursor-import', name: 'Cursor Import', type: 'cursor', base_url: 'https://api2.cursor.sh', flow: 'api-key', notes: 'Paste Cursor access token as API key. OAuth is not available; 9router uses local token import.' },
  { id: 'alicode', name: 'Alibaba Coding', type: 'openai-compatible', base_url: 'https://coding.dashscope.aliyuncs.com/v1' },
  { id: 'alicode-intl', name: 'Alibaba Coding Intl', type: 'openai-compatible', base_url: 'https://coding-intl.dashscope.aliyuncs.com/v1' },
  { id: 'volcengine-ark', name: 'Volcengine Ark', type: 'openai-compatible', base_url: 'https://ark.cn-beijing.volces.com/api/coding/v3' },
  { id: 'byteplus', name: 'BytePlus ModelArk', type: 'openai-compatible', base_url: 'https://ark.ap-southeast.bytepluses.com/api/coding/v3' },
  { id: 'glm-cn', name: 'GLM China', type: 'openai-compatible', base_url: 'https://open.bigmodel.cn/api/coding/paas/v4' },
  { id: 'glm', name: 'GLM Coding', type: 'anthropic-compatible', base_url: 'https://api.z.ai/api/anthropic' },
  { id: 'kimi', name: 'Kimi Coding', type: 'anthropic-compatible', base_url: 'https://api.kimi.com/coding' },
  { id: 'minimax', name: 'MiniMax', type: 'anthropic-compatible', base_url: 'https://api.minimax.io/anthropic' },
  { id: 'minimax-cn', name: 'MiniMax China', type: 'anthropic-compatible', base_url: 'https://api.minimaxi.com/anthropic' },
  { id: 'ollama-local', name: 'Ollama Local', type: 'ollama', base_url: 'http://localhost:11434', flow: 'local' },
  { id: 'bud-web', name: 'Bud Web Login', type: 'bud-web', base_url: 'https://bud.app', flow: 'web-cookie', notes: 'Bud uses Google login through Clerk on bud.app. Create the provider, log in on bud.app, then import the session with the Chrome extension.' },
  { id: 'devin-web', name: 'Devin Web Login', type: 'devin-web', base_url: 'https://app.devin.ai', flow: 'web-cookie', notes: 'Devin uses Google/Auth0 login on app.devin.ai. Create the provider, log in on app.devin.ai, then import the session with the Chrome extension.' },
  { id: 'perplexity-web', name: 'Perplexity Web (Free)', type: 'perplexity-web', base_url: 'https://www.perplexity.ai', flow: 'web-cookie', notes: 'Uses session cookies from perplexity.ai. Extract with Chrome extension. Free account — no API key required.' },
  { id: 'zenmux-web', name: 'ZenMux Web Login', type: 'zenmux-web', base_url: 'https://zenmux.ai', flow: 'web-cookie', notes: 'ZenMux uses website login on zenmux.ai. Create the provider, log in on zenmux.ai, then import the session with the Chrome extension. For API-key mode, add https://zenmux.ai/api/v1 as OpenAI-compatible.' },
] as ProviderPreset[]).map((preset): ProviderPreset => ({
  ...preset,
  flow: (preset.flow ?? (preset.oauth ? 'oauth' : 'api-key')) as ProviderPreset['flow'],
}));
