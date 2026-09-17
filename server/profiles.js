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
  const migrationPath = path.join(dataDir, 'profiles-legacy-migrated.json');
  let pendingWrite = Promise.resolve();

  function scopedPath(userId) {
    const safeId = String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(dataDir, 'users', safeId, 'profiles.json');
  }

  async function migrateLegacy(userId) {
    if (!userId) return profilesPath;
    const targetPath = scopedPath(userId);
    try { await fs.access(targetPath); return targetPath; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let marker = {};
    try { marker = JSON.parse(await fs.readFile(migrationPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!marker.userId) {
      let legacy = null;
      try { legacy = JSON.parse(await fs.readFile(profilesPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      if (legacy) await fs.writeFile(targetPath, `${JSON.stringify(normalizeProfileState(legacy), null, 2)}\n`, { mode: 0o600 });
      marker.userId = userId;
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(migrationPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    }
    return targetPath;
  }

  async function get({ userId = '' } = {}) {
    const storagePath = await migrateLegacy(userId);
    try {
      const stored = JSON.parse(await fs.readFile(storagePath, 'utf8'));
      return normalizeProfileState(stored);
    } catch (error) {
      if (error.code === 'ENOENT') return { ...EMPTY_PROFILE_STATE };
      throw error;
    }
  }

  async function replace(value, { userId = '' } = {}) {
    const next = normalizeProfileState(value);
    const storagePath = await migrateLegacy(userId);
    pendingWrite = pendingWrite.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(storagePath), { recursive: true });
      const temporaryPath = `${storagePath}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporaryPath, storagePath);
    });
    await pendingWrite;
    return next;
  }

  return { get, replace };
}

export { EMPTY_PROFILE_STATE };
