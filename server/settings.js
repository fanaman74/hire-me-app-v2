import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SEARCH_SOURCES } from '../shared/search-sources.js';

export const PROVIDERS = {
  openrouter: { id: 'openrouter', label: 'OpenRouter', env: 'OPENROUTER_API_KEY' },
  claude: { id: 'claude', label: 'Claude', env: 'ANTHROPIC_API_KEY' },
  openai: { id: 'openai', label: 'ChatGPT', env: 'OPENAI_API_KEY' },
  kimi: { id: 'kimi', label: 'Kimi', env: 'MOONSHOT_API_KEY' },
  gemini: { id: 'gemini', label: 'Gemini', env: 'GEMINI_API_KEY' },
};

export const DIRECT_MODELS = {
  claude: [
    { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', description: 'Balanced reasoning and writing', contextLength: 200000, supportsTools: false },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', description: 'Fast, efficient Claude model', contextLength: 200000, supportsTools: false },
  ],
  openai: [
    { id: 'gpt-4.1', name: 'GPT-4.1', description: 'Strong general purpose model', contextLength: 1047576, supportsTools: false },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', description: 'Fast, capable, and economical', contextLength: 1047576, supportsTools: false },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: 'Fast everyday model', contextLength: 128000, supportsTools: false },
  ],
  kimi: [
    { id: 'kimi-k3', name: 'Kimi K3', description: 'Frontier multimodal Kimi model', contextLength: 1000000, supportsTools: false },
    { id: 'kimi-k2.6', name: 'Kimi K2.6', description: 'Multimodal Kimi model with thinking mode', contextLength: 256000, supportsTools: false },
  ],
  gemini: [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Fast multimodal Gemini model', contextLength: 1048576, supportsTools: false },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Advanced reasoning Gemini model', contextLength: 1048576, supportsTools: false },
  ],
};

export const DEFAULT_SETTINGS = {
  provider: 'openrouter',
  model: 'openai/gpt-4.1-mini',
  temperature: 0.3,
  maxTokens: 4096,
  searchSources: DEFAULT_SEARCH_SOURCES,
};

export function normalizeProvider(value) { return Object.hasOwn(PROVIDERS, value) ? value : DEFAULT_SETTINGS.provider; }
export function modelsForProvider(provider) { return DIRECT_MODELS[normalizeProvider(provider)] || []; }

function envKeyNames(provider) {
  const names = [PROVIDERS[provider]?.env];
  if (provider === 'claude') names.push('CLAUDE_API_KEY');
  if (provider === 'kimi') names.push('KIMI_API_KEY');
  if (provider === 'gemini') names.push('GOOGLE_GEMINI_API_KEY');
  return names.filter(Boolean);
}

function envKey(provider) {
  for (const name of envKeyNames(provider)) {
    if (String(process.env[name] || '').trim()) return { key: String(process.env[name]).trim(), source: 'environment' };
  }
  return { key: '', source: null };
}

function cleanKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([provider, key]) => Object.hasOwn(PROVIDERS, provider) && typeof key === 'string' && key.trim())
    .map(([provider, key]) => [provider, key.trim()]));
}

export function publicProviderKeyStatus(providerKeys = {}) {
  return Object.fromEntries(Object.keys(PROVIDERS).map((provider) => {
    const environment = envKey(provider);
    const stored = String(providerKeys[provider] || '').trim();
    return [provider, { configured: Boolean(environment.key || stored), source: environment.key ? environment.source : stored ? 'settings' : null }];
  }));
}

export function createSettingsStore(rootDir) {
  const dataDir = process.env.HMA_DATA_DIR ? path.resolve(process.env.HMA_DATA_DIR) : path.join(rootDir, '.data');
  const settingsPath = path.join(dataDir, 'settings.json');
  const migrationPath = path.join(dataDir, 'settings-legacy-migrated.json');
  function scopedPath(userId) { return path.join(dataDir, 'users', String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '_'), 'settings.json'); }
  async function migrateLegacy(userId) {
    if (!userId) return settingsPath;
    const targetPath = scopedPath(userId);
    try { await fs.access(targetPath); return targetPath; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let marker = {};
    try { marker = JSON.parse(await fs.readFile(migrationPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!marker.userId) {
      let legacy = null;
      try { legacy = JSON.parse(await fs.readFile(settingsPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      if (legacy) await fs.writeFile(targetPath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
      marker.userId = userId;
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(migrationPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    }
    return targetPath;
  }
  async function readRaw(storagePath = settingsPath) {
    try { return JSON.parse(await fs.readFile(storagePath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  return {
    async get({ includeSecret = false, userId = '' } = {}) {
      const raw = await readRaw(await migrateLegacy(userId));
      const storedKeys = cleanKeys(raw.providerKeys);
      if (!storedKeys.openrouter && typeof raw.apiKey === 'string' && raw.apiKey.trim()) storedKeys.openrouter = raw.apiKey.trim();
      const provider = normalizeProvider(raw.provider);
      const keys = Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, envKey(id).key || storedKeys[id] || '']));
      const selectedKey = keys[provider] || '';
      const directDefault = modelsForProvider(provider)[0]?.id;
      const savedModel = String(raw.model || '');
      const model = provider === 'openrouter' || modelsForProvider(provider).some((entry) => entry.id === savedModel) ? savedModel || DEFAULT_SETTINGS.model : directDefault;
      const result = {
        provider,
        model,
        temperature: Number.isFinite(Number(raw.temperature)) ? Number(raw.temperature) : DEFAULT_SETTINGS.temperature,
        maxTokens: Number.isInteger(Number(raw.maxTokens)) ? Number(raw.maxTokens) : DEFAULT_SETTINGS.maxTokens,
        searchSources: Array.isArray(raw.searchSources) ? raw.searchSources : DEFAULT_SEARCH_SOURCES,
        providerKeys: publicProviderKeyStatus(storedKeys),
        apiKeyConfigured: Boolean(selectedKey),
        apiKeySource: envKey(provider).key ? 'environment' : selectedKey ? 'settings' : null,
      };
      if (includeSecret) { result.providerKeys = keys; result.apiKey = selectedKey; }
      return result;
    },
    async update(next, { userId = '' } = {}) {
      const storagePath = await migrateLegacy(userId);
      const current = await readRaw(storagePath);
      const provider = normalizeProvider(next.provider || current.provider);
      const providerKeys = cleanKeys(current.providerKeys);
      if (!providerKeys.openrouter && typeof current.apiKey === 'string' && current.apiKey.trim()) providerKeys.openrouter = current.apiKey.trim();
      if (next.providerKeys && typeof next.providerKeys === 'object') {
        for (const [id, value] of Object.entries(next.providerKeys)) {
          if (Object.hasOwn(PROVIDERS, id) && typeof value === 'string' && value.trim()) providerKeys[id] = value.trim();
        }
      }
      if (typeof next.apiKey === 'string' && next.apiKey.trim()) providerKeys[provider] = next.apiKey.trim();
      if (next.clearApiKey === true) delete providerKeys[provider];
      const updated = { ...current, provider, model: next.model, temperature: next.temperature, maxTokens: next.maxTokens, searchSources: next.searchSources, providerKeys };
      delete updated.apiKey;
      delete updated.customSearchSites;
      await fs.mkdir(dataDir, { recursive: true });
      await fs.mkdir(path.dirname(storagePath), { recursive: true });
      await fs.writeFile(storagePath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
      return this.get({ userId });
    },
  };
}
