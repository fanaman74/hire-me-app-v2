import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SEARCH_SOURCES } from '../shared/search-sources.js';

export const DEFAULT_SETTINGS = {
  model: 'openai/gpt-4.1-mini',
  temperature: 0.3,
  maxTokens: 4096,
  searchSources: DEFAULT_SEARCH_SOURCES,
};

export function createSettingsStore(rootDir) {
  const dataDir = process.env.HMA_DATA_DIR
    ? path.resolve(process.env.HMA_DATA_DIR)
    : path.join(rootDir, '.data');
  const settingsPath = path.join(dataDir, 'settings.json');
  const migrationPath = path.join(dataDir, 'settings-legacy-migrated.json');

  function scopedPath(userId) {
    const safeId = String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(dataDir, 'users', safeId, 'settings.json');
  }

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
    try {
      return JSON.parse(await fs.readFile(storagePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  return {
    async get({ includeSecret = false, userId = '' } = {}) {
      const storagePath = await migrateLegacy(userId);
      const stored = { ...DEFAULT_SETTINGS, ...(await readRaw(storagePath)) };
      const apiKey = process.env.OPENROUTER_API_KEY || stored.apiKey || '';
      const result = {
        model: stored.model,
        temperature: stored.temperature,
        maxTokens: stored.maxTokens,
        searchSources: Array.isArray(stored.searchSources) ? stored.searchSources : DEFAULT_SEARCH_SOURCES,
        apiKeyConfigured: Boolean(apiKey),
        apiKeySource: process.env.OPENROUTER_API_KEY ? 'environment' : apiKey ? 'settings' : null,
      };
      if (includeSecret) result.apiKey = apiKey;
      return result;
    },

    async update(next, { userId = '' } = {}) {
      const storagePath = await migrateLegacy(userId);
      const current = await readRaw(storagePath);
      const updated = {
        ...current,
        model: next.model,
        temperature: next.temperature,
        maxTokens: next.maxTokens,
        searchSources: next.searchSources,
      };
      delete updated.customSearchSites;
      if (typeof next.apiKey === 'string' && next.apiKey.trim()) {
        updated.apiKey = next.apiKey.trim();
      }
      if (next.clearApiKey === true) delete updated.apiKey;
      await fs.mkdir(dataDir, { recursive: true });
      await fs.mkdir(path.dirname(storagePath), { recursive: true });
      await fs.writeFile(storagePath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
      return this.get({ userId });
    },
  };
}
