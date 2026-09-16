import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSettingsStore, DEFAULT_SETTINGS } from './settings.js';

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
