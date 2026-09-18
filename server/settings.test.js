import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { customSearchSourceId } from '../shared/search-sources.js';
import { createSettingsStore, DEFAULT_SETTINGS, modelsForProvider, normalizeCustomProvider } from './settings.js';

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
  assert.deepEqual(modelsForProvider('deepseek').map((model) => model.id), ['deepseek-chat', 'deepseek-reasoner']);
  assert.deepEqual(modelsForProvider('routera').map((model) => model.id), ['openai/gpt-5.5']);
});

test('settings store persists custom OpenAI-compatible providers without exposing keys', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hire-me-agents-custom-provider-'));
  const store = createSettingsStore(root);
  const customProvider = { label: 'Together', baseUrl: 'https://api.together.xyz/v1/', model: 'meta-llama/Llama-3.3-70B-Instruct' };
  assert.deepEqual(normalizeCustomProvider(customProvider), { label: 'Together', baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct' });
  await store.update({ provider: 'custom', model: customProvider.model, customProvider, temperature: 0.3, maxTokens: 4096, searchSources: ['remoteok'], apiKey: 'custom-secret' });
  const publicSettings = await store.get();
  assert.equal(publicSettings.provider, 'custom');
  assert.deepEqual(publicSettings.customProvider, { label: 'Together', baseUrl: 'https://api.together.xyz/v1', model: customProvider.model });
  assert.equal(publicSettings.providerKeys.custom.key, undefined);
  const privateSettings = await store.get({ includeSecret: true });
  assert.equal(privateSettings.apiKey, 'custom-secret');
});

test('saved user provider keys take precedence over environment fallback keys', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hire-me-agents-env-key-'));
  const previous = process.env.ROUTERA_API_KEY;
  try {
    process.env.ROUTERA_API_KEY = 'environment-routera-key';
    const store = createSettingsStore(root);
    await store.update({
      provider: 'routera',
      model: 'openai/gpt-5.5',
      temperature: 0.3,
      maxTokens: 4096,
      searchSources: ['remoteok'],
      apiKey: 'profile-routera-key',
    });
    const publicSettings = await store.get();
    assert.equal(publicSettings.providerKeys.routera.source, 'settings');
    assert.equal(publicSettings.apiKeySource, 'settings');
    const privateSettings = await store.get({ includeSecret: true });
    assert.equal(privateSettings.apiKey, 'profile-routera-key');
  } finally {
    if (previous === undefined) delete process.env.ROUTERA_API_KEY;
    else process.env.ROUTERA_API_KEY = previous;
  }
});

test('settings store persists country and normalized custom sources', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hire-me-agents-custom-sources-'));
  const store = createSettingsStore(root);
  const source = { label: 'Example Careers', url: 'example.com/careers/#jobs', description: 'Employer vacancies' };
  await store.update({
    provider: 'openrouter', model: DEFAULT_SETTINGS.model, temperature: 0.3, maxTokens: 4096,
    searchCountry: 'Belgium', customSearchSources: [source], searchSources: ['hn_hiring', customSearchSourceId('https://example.com/careers')],
  });
  const settings = await store.get();
  assert.equal(settings.searchCountry, 'Belgium');
  assert.equal(settings.customSearchSources.length, 1);
  assert.equal(settings.customSearchSources[0].url, 'https://example.com/careers');
  assert.equal(settings.customSearchSources[0].custom, true);
  assert.deepEqual(settings.searchSources, ['hn_hiring', customSearchSourceId('https://example.com/careers')]);
  await assert.rejects(() => store.update({ ...settings, customSearchSources: [{ label: 'Bad', url: 'javascript:alert(1)' }] }), /valid HTTP or HTTPS/);
});
