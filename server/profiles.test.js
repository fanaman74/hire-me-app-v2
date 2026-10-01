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

test('profile store reload preserves original CV and role-linked tailored CV state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hire-me-agents-profiles-cv-'));
  const state = {
    candidates: [{
      id: 'candidate-cv',
      name: 'CV Owner',
      resumeText: 'ORIGINAL CV — unchanged source text',
      jobs: [{
        id: 'job-role',
        title: 'Head of Engineering',
        manualRole: true,
        vacancyText: 'Full vacancy retained here',
        stage: 'new',
        tailoredCv: { content: '# Tailored CV', status: 'approved', updatedAt: '2026-09-30T10:00:00.000Z', approvedAt: '2026-09-30T10:01:00.000Z' },
      }, {
        id: 'job-combination',
        title: 'Platform Director',
        manualRole: true,
        vacancyText: 'Combination role vacancy',
        tailoredCv: { content: '# Combination CV', status: 'draft', format: 'combination' },
      }, {
        id: 'job-europass',
        title: 'Engineering Director',
        manualRole: true,
        vacancyText: 'Europass role vacancy',
        tailoredCv: { content: '# Europass CV', status: 'draft', format: 'europass' },
      }],
    }],
    activeCandidateId: 'candidate-cv',
  };
  const firstStore = createProfileStore(root);
  await firstStore.replace(state, { userId: 'reload-user' });
  const reloaded = await createProfileStore(root).get({ userId: 'reload-user' });
  assert.equal(reloaded.candidates[0].resumeText, state.candidates[0].resumeText);
  assert.deepEqual(reloaded.candidates[0].jobs[0].tailoredCv, { ...state.candidates[0].jobs[0].tailoredCv, format: 'chronological' });
  assert.equal(reloaded.candidates[0].jobs[1].tailoredCv.format, 'combination');
  assert.equal(reloaded.candidates[0].jobs[2].tailoredCv.format, 'europass');
  assert.equal(reloaded.candidates[0].jobs[0].vacancyText, state.candidates[0].jobs[0].vacancyText);
  assert.equal(reloaded.candidates[0].jobs[0].stage, 'new');
  assert.deepEqual(await createProfileStore(root).get({ userId: 'other-user' }), { candidates: [], activeCandidateId: '' });
});
