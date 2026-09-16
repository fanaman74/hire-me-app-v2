import fs from 'node:fs/promises';
import path from 'node:path';

const EMPTY_PROFILE_STATE = { candidates: [], activeCandidateId: '' };

function normalizeProfileState(value) {
  if (!value || !Array.isArray(value.candidates)) {
    const error = new Error('Profiles must be provided as an array.');
    error.status = 400;
    throw error;
  }

  if (value.candidates.length > 100) {
    const error = new Error('A maximum of 100 local profiles is supported.');
    error.status = 400;
    throw error;
  }

  const ids = new Set();
  for (const candidate of value.candidates) {
    if (!candidate || typeof candidate !== 'object' || typeof candidate.id !== 'string' || !candidate.id.trim() || ids.has(candidate.id)) {
      const error = new Error('Every profile must have a unique ID.');
      error.status = 400;
      throw error;
    }
    ids.add(candidate.id);
  }

  return {
    candidates: value.candidates,
    activeCandidateId: typeof value.activeCandidateId === 'string' ? value.activeCandidateId : '',
  };
}

export function createProfileStore(rootDir) {
  const dataDir = process.env.HMA_DATA_DIR
    ? path.resolve(process.env.HMA_DATA_DIR)
    : path.join(rootDir, '.data');
  const profilesPath = path.join(dataDir, 'profiles.json');
  let pendingWrite = Promise.resolve();

  async function get() {
    try {
      const stored = JSON.parse(await fs.readFile(profilesPath, 'utf8'));
      return normalizeProfileState(stored);
    } catch (error) {
      if (error.code === 'ENOENT') return { ...EMPTY_PROFILE_STATE };
      throw error;
    }
  }

  async function replace(value) {
    const next = normalizeProfileState(value);
    pendingWrite = pendingWrite.catch(() => {}).then(async () => {
      await fs.mkdir(dataDir, { recursive: true });
      const temporaryPath = `${profilesPath}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporaryPath, profilesPath);
    });
    await pendingWrite;
    return next;
  }

  return { get, replace };
}

export { EMPTY_PROFILE_STATE };
