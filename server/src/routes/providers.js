import { Router } from 'express';
import { verify, requireAdmin } from '../auth.js';
import {
  listProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  setActiveProvider,
  getActiveProviderIds,
  getProviderUnmaskedById
} from '../store.js';

export const router = Router();
router.use(verify);


export const PROVIDER_PRESETS = [
  {
    name: 'OpenAI',
    providerType: 'openai-compatible',
    appType: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    textModel: 'gpt-4o-mini',
    imageModel: 'gpt-image-1'
  },
  {
    name: 'OpenRouter',
    providerType: 'openai-compatible',
    appType: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    textModel: 'openai/gpt-4o-mini',
    imageModel: ''
  },
  {
    name: 'DeepSeek',
    providerType: 'openai-compatible',
    appType: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    textModel: 'deepseek-chat',
    imageModel: ''
  },
  {
    name: 'Groq',
    providerType: 'openai-compatible',
    appType: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    textModel: 'llama3-70-70b-instruct',
    imageModel: ''
  },
  {
    name: 'SenseNova 开放平台',
    providerType: 'openai-compatible',
    appType: 'openai',
    baseUrl: 'https://token.sensenova.cn/v1',
    textModel: 'sensenova-6.8-flash-lite',
    imageModel: 'sensenova-u1.5-lite'
  }
];

router.get('/', async (req, res, next) => {
  try {
    const providers = await listProviders();
    const activeIds = await getActiveProviderIds(req.user.userId);
    res.json({ providers, ...activeIds, presets: PROVIDER_PRESETS });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const created = await addProvider(req.body);
    const providers = await listProviders();
    const activeIds = await getActiveProviderIds(req.user.userId);
    res.status(201).json({ provider: created, providers, ...activeIds });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    const updated = await updateProvider(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'provider_not_found' });
    const providers = await listProviders();
    const activeIds = await getActiveProviderIds(req.user.userId);
    res.json({ provider: updated, providers, ...activeIds });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const removed = await deleteProvider(req.params.id);
    if (!removed) return res.status(404).json({ error: 'provider_not_found' });
    const providers = await listProviders();
    const activeIds = await getActiveProviderIds(req.user.userId);
    res.json({ providers, ...activeIds });
  } catch (err) {
    next(err);
  }
});

// Fetch model list from an arbitrary provider endpoint.
router.post('/_models', async (req, res, next) => {
  try {
    let { baseUrl, apiKey, providerId } = req.body || {};
    if (providerId) {
      const existing = await getProviderUnmaskedById(providerId);
      if (!existing) return res.status(404).json({ error: 'provider_not_found' });
      baseUrl = existing.baseUrl;
      apiKey = existing.apiKey;
    }
    if (!baseUrl || !apiKey) return res.status(400).json({ error: 'missing baseUrl or apiKey' });
    const normalized = baseUrl.replace(/\/+$/, '');
    const url = normalized + '/models';
    const resp = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' }
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { return res.status(502).json({ error: 'invalid_response', upstream: text.slice(0, 200) }); }
    if (!resp.ok) return res.status(resp.status).json({ error: 'upstream_error', status: resp.status, body: data });
    const models = [];
    const arr = Array.isArray(data) ? data : (data.data || data.models || data.result || []);
    for (const m of arr) {
      if (typeof m === 'string') models.push(m);
      else if (m && typeof m === 'object') models.push(m.id || m.model || m.name || m.modelId || '');
    }
    const cleaned = Array.from(new Set(models.filter(Boolean))).sort();
    res.json({ models: cleaned });
  } catch (err) {
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err.message || 'fetch_failed' });
  }
});

router.post('/:id/duplicate', requireAdmin, async (req, res, next) => {
  try {
    const existing = await getProviderUnmaskedById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'provider_not_found' });
    const baseName = existing.name || '供应商';
    const names = new Set((await listProviders()).map(p => p.name));
    let index = 1;
    let name = baseName + '-' + index;
    while (names.has(name)) { index += 1; name = baseName + '-' + index; }
    const created = await addProvider({
      name,
      providerType: existing.providerType,
      appType: existing.appType,
      baseUrl: existing.baseUrl,
      apiKey: existing.apiKey,
      mode: existing.mode,
      textModel: existing.textModel,
      imageModel: existing.imageModel,
      notes: existing.notes,
      active: false
    });
    const providers = await listProviders();
    const activeIds = await getActiveProviderIds(req.user.userId);
    res.status(201).json({ provider: created, providers, ...activeIds });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/active', async (req, res, next) => {
  try {
    const mode = (req.body && req.body.mode) || null;
    await setActiveProvider(req.params.id, mode, req.user.userId);
    const providers = await listProviders();
    const activeIds = await getActiveProviderIds(req.user.userId);
    res.json({ providers, ...activeIds });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/api-key', requireAdmin, async (req, res, next) => {
  try {
    const target = await getProviderUnmaskedById(req.params.id);
    if (!target) return res.status(404).json({ error: 'provider_not_found' });
    res.json({ providerId: target.id, apiKey: target.apiKey || '' });
  } catch (err) {
    next(err);
  }
});


