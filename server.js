// server.js — AISprint AI Proxy
// Runs on Railway. All AI provider API keys stay here — never sent to browser.

const express  = require('express');
const cors     = require('cors');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname)));

// ── Allowed emails gate (also enforced client-side in index.html) ──────────
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

function isAllowed(email) {
  if (!email) return false;
  return ALLOWED_EMAILS.includes(email.trim().toLowerCase());
}

// ── Provider configs — keys read from Railway env vars ────────────────────
const PROVIDERS = {
  claude: {
    url:    'https://api.anthropic.com/v1/messages',
    getKey: () => process.env.CLAUDE_API_KEY,
    buildHeaders: (key) => ({
      'Content-Type':      'application/json',
      'x-api-key':         key,
      'anthropic-version': '2023-06-01',
    }),
    buildBody: (model, messages, system, max_tokens) => ({
      model:      model || 'claude-sonnet-4-6',
      max_tokens: max_tokens || 1024,
      ...(system ? { system } : {}),
      messages,
    }),
    extractText: (data) => data?.content?.[0]?.text || '',
  },

  deepseek: {
    url:    'https://api.deepseek.com/v1/chat/completions',
    getKey: () => process.env.DEEPSEEK_API_KEY,
    buildHeaders: (key) => ({
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${key}`,
    }),
    buildBody: (model, messages, system, max_tokens) => ({
      model:      model || 'deepseek-chat',
      max_tokens: max_tokens || 1024,
      messages:   system ? [{ role: 'system', content: system }, ...messages] : messages,
    }),
    extractText: (data) => data?.choices?.[0]?.message?.content || '',
  },

  gemini: {
    url:    null, // built dynamically with key in URL
    getKey: () => process.env.GEMINI_API_KEY,
    buildUrl: (key, model) => {
      const m = model || 'gemini-2.0-flash';
      return `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`;
    },
    buildHeaders: () => ({ 'Content-Type': 'application/json' }),
    buildBody: (model, messages, system) => {
      const contents = messages.map(m => ({
        role:  m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
      return {
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      };
    },
    extractText: (data) => data?.candidates?.[0]?.content?.parts?.[0]?.text || '',
  },

  perplexity: {
    url:    'https://api.perplexity.ai/chat/completions',
    getKey: () => process.env.PERPLEXITY_API_KEY,
    buildHeaders: (key) => ({
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${key}`,
    }),
    buildBody: (model, messages, system, max_tokens) => ({
      model:      model || 'sonar-pro',
      max_tokens: max_tokens || 1024,
      messages:   system ? [{ role: 'system', content: system }, ...messages] : messages,
    }),
    extractText: (data) => data?.choices?.[0]?.message?.content || '',
  },

  openai: {
    url:    'https://api.openai.com/v1/chat/completions',
    getKey: () => process.env.OPENAI_API_KEY,
    buildHeaders: (key) => ({
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${key}`,
    }),
    buildBody: (model, messages, system, max_tokens) => ({
      model:      model || 'gpt-4o-mini',
      max_tokens: max_tokens || 1024,
      messages:   system ? [{ role: 'system', content: system }, ...messages] : messages,
    }),
    extractText: (data) => data?.choices?.[0]?.message?.content || '',
  },
};

// ── Latest model lists — returned to frontend for selectors ───────────────
const MODELS = {
  claude: [
    { id: 'claude-opus-4-6',    label: 'Claude Opus 4.6',    note: 'Most powerful' },
    { id: 'claude-sonnet-4-6',  label: 'Claude Sonnet 4.6',  note: 'Recommended' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', note: 'Fastest' },
  ],
  deepseek: [
    { id: 'deepseek-chat',      label: 'DeepSeek Chat',       note: 'Recommended' },
    { id: 'deepseek-reasoner',  label: 'DeepSeek Reasoner',   note: 'R1 reasoning' },
  ],
  gemini: [
    { id: 'gemini-2.0-flash',          label: 'Gemini 2.0 Flash',         note: 'Recommended' },
    { id: 'gemini-2.0-flash-thinking-exp', label: 'Gemini 2.0 Flash Thinking', note: 'Reasoning' },
    { id: 'gemini-1.5-pro',            label: 'Gemini 1.5 Pro',           note: 'Long context' },
  ],
  perplexity: [
    { id: 'sonar-pro',          label: 'Sonar Pro',           note: 'Recommended — web search' },
    { id: 'sonar',              label: 'Sonar',               note: 'Fast web search' },
    { id: 'sonar-reasoning-pro',label: 'Sonar Reasoning Pro', note: 'Deep research' },
  ],
  openai: [
    { id: 'gpt-4o',             label: 'GPT-4o',              note: 'Most capable' },
    { id: 'gpt-4o-mini',        label: 'GPT-4o Mini',         note: 'Recommended' },
    { id: 'o3-mini',            label: 'o3-mini',             note: 'Reasoning' },
  ],
};

// ── GET /api/providers — which providers have keys configured ──────────────
app.get('/api/providers', (req, res) => {
  const available = {};
  Object.keys(PROVIDERS).forEach(p => {
    const key = PROVIDERS[p].getKey();
    available[p] = {
      enabled: !!key,
      models:  key ? MODELS[p] : [],
    };
  });
  res.json({ providers: available });
});

// ── POST /api/ai — main proxy endpoint ────────────────────────────────────
// Body: { email, provider, model, messages, system, max_tokens }
app.post('/api/ai', async (req, res) => {
  const { email, provider, model, messages, system, max_tokens } = req.body;

  // Auth check
  if (!isAllowed(email)) {
    return res.status(403).json({ error: 'Access denied.' });
  }

  // Provider check
  const prov = PROVIDERS[provider];
  if (!prov) {
    return res.status(400).json({ error: `Unknown provider: ${provider}` });
  }

  const key = prov.getKey();
  if (!key) {
    return res.status(503).json({ error: `${provider} API key not configured on server.` });
  }

  if (!messages || !messages.length) {
    return res.status(400).json({ error: 'messages array is required.' });
  }

  try {
    const url     = prov.buildUrl ? prov.buildUrl(key, model) : prov.url;
    const headers = prov.buildHeaders(key);
    const body    = prov.buildBody(model, messages, system, max_tokens);

    const response = await fetch(url, {
      method:  'POST',
      headers,
      body:    JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(`[${provider}] error:`, data);
      return res.status(response.status).json({
        error: data?.error?.message || data?.message || 'Provider error',
        raw:   data,
      });
    }

    const text = prov.extractText(data);
    res.json({ text, provider, model: model || 'default', raw: data });

  } catch (err) {
    console.error(`[${provider}] fetch error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/verify-email — check if email is on whitelist ────────────────
app.get('/api/verify-email', (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  res.json({ allowed: isAllowed(email) });
});

// ── Fallback — serve index.html for all unmatched routes ─────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AISprint Tools running on port ${PORT}`);
  console.log(`Providers configured: ${Object.keys(PROVIDERS).filter(p => PROVIDERS[p].getKey()).join(', ') || 'none'}`);
});
