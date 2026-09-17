import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSettingsStore, DEFAULT_SETTINGS, modelsForProvider } from './settings.js';

test('settings store returns defaults and persists model choices', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hire-me-agents-'));
  const store = createSettingsStore(root);
  const initial = await store.get();
  assert.equal(initial.model, DEFAULT_SETTINGS.model);
  assert.equal(initial.apiKeyConfigured, false);

  await store.update({
    model: 'anthropic/claude-sonnet-4',
    temperature: 0.5,
    maxTokens: 2048,
    searchSources: ['remoteok', 'wellfound'],
    apiKey: 'sk-or-test',
  });
  const updated = await store.get({ includeSecret: true });
  assert.equal(updated.model, 'anthropic/claude-sonnet-4');
  assert.equal(updated.apiKey, 'sk-or-test');
  assert.equal(updated.apiKeyConfigured, true);
  assert.deepEqual(updated.searchSources, ['remoteok', 'wellfound']);
});

test('settings store migrates legacy OpenRouter keys and keeps provider keys private', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hire-me-agents-provider-'));
  await fs.mkdir(path.join(root, '.data'), { recursive: true });
  await fs.writeFile(path.join(root, '.data', 'settings.json'), JSON.stringify({ apiKey: 'legacy-openrouter-key', model: 'openai/gpt-4.1-mini' }));
  const store = createSettingsStore(root);
  const publicSettings = await store.get();
  assert.equal(publicSettings.provider, 'openrouter');
  assert.equal(publicSettings.apiKeyConfigured, true);
  assert.equal(publicSettings.providerKeys.openrouter.configured, true);
  assert.equal(publicSettings.providerKeys.openrouter.key, undefined);

  await store.update({ provider: 'claude', model: 'claude-sonnet-4-5-20250929', temperature: 0.2, maxTokens: 1024, searchSources: ['remoteok'], apiKey: 'anthropic-secret' });
  const direct = await store.get({ includeSecret: true });
  assert.equal(direct.provider, 'claude');
  assert.equal(direct.apiKey, 'anthropic-secret');
  assert.equal(direct.providerKeys.openrouter, 'legacy-openrouter-key');
  assert.deepEqual(modelsForProvider('gemini').map((model) => model.id), ['gemini-2.5-flash', 'gemini-2.5-pro']);
  assert.deepEqual(modelsForProvider('kimi').map((model) => model.id), ['kimi-k3', 'kimi-k2.6']);
});
