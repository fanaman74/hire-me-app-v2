import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProfileStore } from './profiles.js';

test('profile store starts empty and persists profiles locally', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hire-me-agents-profiles-'));
  const store = createProfileStore(root);

  assert.deepEqual(await store.get(), { candidates: [], activeCandidateId: '' });

  const state = {
    candidates: [{ id: 'candidate-1', name: 'Local Profile', resumeText: 'CV text' }],
    activeCandidateId: 'candidate-1',
  };
  assert.deepEqual(await store.replace(state), state);
  assert.deepEqual(await store.get(), state);
});

test('profile store rejects malformed profile state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hire-me-agents-profiles-'));
  const store = createProfileStore(root);
  await assert.rejects(() => store.replace({ candidates: 'invalid' }), /array/);
  await assert.rejects(() => store.replace({ candidates: [{ id: 'same' }, { id: 'same' }] }), /unique ID/);
});
