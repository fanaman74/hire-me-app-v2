import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SESSION_COOKIE = 'hma_session';
const OAUTH_STATE_COOKIE = 'hma_oauth_state';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 8;

function dataDirectory(rootDir) {
  return process.env.HMA_DATA_DIR
    ? path.resolve(process.env.HMA_DATA_DIR)
    : path.join(rootDir, '.data');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function configuredAdminEmails() {
  return new Set(String(process.env.ADMIN_EMAILS || '')
    .split(/[\s,;]+/)
    .map(normalizeEmail)
    .filter(Boolean));
}

function isAdminEmail(email) {
  return configuredAdminEmails().has(normalizeEmail(email));
}

function publicUser(user) {
  const isAdmin = isAdminEmail(user.email);
  return { id: user.id, email: user.email, createdAt: user.createdAt, provider: user.provider || 'local', role: isAdmin ? 'admin' : 'user', isAdmin };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function parseCookies(header) {
  return String(header || '').split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index < 0) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      try { cookies[key] = decodeURIComponent(value); } catch { /* Ignore malformed cookies. */ }
    }
    return cookies;
  }, {});
}

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, derivedKey) => {
      if (error) return reject(error);
      resolve({ salt, hash: derivedKey.toString('hex') });
    });
  });
}

async function verifyPassword(password, user) {
  if (!user?.passwordHash || !user.passwordSalt) return false;
  const result = await passwordHash(password, user.passwordSalt);
  const expected = Buffer.from(user.passwordHash, 'hex');
  const actual = Buffer.from(result.hash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function validateCredentials(emailValue, passwordValue) {
  const email = normalizeEmail(emailValue);
  const password = String(passwordValue || '');
  if (!validEmail(email)) {
    const error = new Error('Enter a valid email address.');
    error.status = 400;
    throw error;
  }
  if (password.length < PASSWORD_MIN_LENGTH || password.length > 200) {
    const error = new Error(`Password must be between ${PASSWORD_MIN_LENGTH} and 200 characters.`);
    error.status = 400;
    throw error;
  }
  return { email, password };
}

export function createAuthStore(rootDir) {
  const dataDir = dataDirectory(rootDir);
  const authPath = path.join(dataDir, 'auth.json');
  let pendingWrite = Promise.resolve();

  async function read() {
    try {
      const state = JSON.parse(await fs.readFile(authPath, 'utf8'));
      return {
        users: Array.isArray(state.users) ? state.users : [],
        sessions: Array.isArray(state.sessions) ? state.sessions : [],
        oauthStates: Array.isArray(state.oauthStates) ? state.oauthStates : [],
      };
    } catch (error) {
      if (error.code === 'ENOENT') return { users: [], sessions: [], oauthStates: [] };
      throw error;
    }
  }

  async function write(state) {
    pendingWrite = pendingWrite.catch(() => {}).then(async () => {
      await fs.mkdir(dataDir, { recursive: true });
      const temporaryPath = `${authPath}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporaryPath, authPath);
    });
    await pendingWrite;
  }

  async function prune(state) {
    const now = Date.now();
    state.sessions = state.sessions.filter((session) => Number(session.expiresAt) > now);
    state.oauthStates = state.oauthStates.filter((item) => Number(item.expiresAt) > now);
  }

  async function createSession(state, userId) {
    const token = randomToken();
    state.sessions.push({ tokenHash: hashToken(token), userId, createdAt: new Date().toISOString(), expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
  }

  return {
    async config() {
      return { googleEnabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) };
    },

    async register(emailValue, passwordValue) {
      const { email, password } = validateCredentials(emailValue, passwordValue);
      const state = await read();
      await prune(state);
      if (state.users.some((user) => user.email === email)) {
        const error = new Error('An account with this email already exists.');
        error.status = 409;
        throw error;
      }
      const { salt, hash } = await passwordHash(password);
      const user = { id: crypto.randomUUID(), email, passwordSalt: salt, passwordHash: hash, provider: 'local', createdAt: new Date().toISOString() };
      state.users.push(user);
      const token = await createSession(state, user.id);
      await write(state);
      return { user: publicUser(user), token };
    },

    async login(emailValue, passwordValue) {
      const email = normalizeEmail(emailValue);
      const password = String(passwordValue || '');
      const state = await read();
      await prune(state);
      const user = state.users.find((candidate) => candidate.email === email);
      const valid = user && password.length <= 200 ? await verifyPassword(password, user) : false;
      if (!valid) {
        const error = new Error('Invalid email or password.');
        error.status = 401;
        throw error;
      }
      const token = await createSession(state, user.id);
      await write(state);
      return { user: publicUser(user), token };
    },

    async getUserForToken(token) {
      if (!token) return null;
      const state = await read();
      await prune(state);
      const session = state.sessions.find((candidate) => candidate.tokenHash === hashToken(token));
      if (!session) return null;
      const user = state.users.find((candidate) => candidate.id === session.userId);
      if (!user) return null;
      return publicUser(user);
    },

    async logout(token) {
      if (!token) return;
      const state = await read();
      state.sessions = state.sessions.filter((session) => session.tokenHash !== hashToken(token));
      await write(state);
    },

    async beginGoogle(stateToken, redirectUri) {
      const state = await read();
      await prune(state);
      state.oauthStates.push({ state: stateToken, redirectUri, expiresAt: Date.now() + OAUTH_STATE_TTL_MS });
      await write(state);
    },

    async consumeGoogleState(stateToken) {
      const state = await read();
      await prune(state);
      const item = state.oauthStates.find((candidate) => candidate.state === stateToken);
      state.oauthStates = state.oauthStates.filter((candidate) => candidate.state !== stateToken);
      await write(state);
      return item && item.expiresAt > Date.now() ? item : null;
    },

    async loginGoogle({ sub, email }) {
      const normalized = normalizeEmail(email);
      if (!sub || !validEmail(normalized)) throw new Error('Google did not return a valid account.');
      const state = await read();
      await prune(state);
      let user = state.users.find((candidate) => candidate.googleSub === sub);
      if (!user) user = state.users.find((candidate) => candidate.email === normalized);
      if (user) {
        user.googleSub = sub;
        user.provider = user.passwordHash ? 'local-google' : 'google';
      } else {
        user = { id: crypto.randomUUID(), email: normalized, googleSub: sub, provider: 'google', createdAt: new Date().toISOString() };
        state.users.push(user);
      }
      const token = await createSession(state, user.id);
      await write(state);
      return { user: publicUser(user), token };
    },

    parseSessionCookie(request) {
      return parseCookies(request.headers.cookie)[SESSION_COOKIE] || '';
    },

    parseOAuthStateCookie(request) {
      return parseCookies(request.headers.cookie)[OAUTH_STATE_COOKIE] || '';
    },

    oauthStateCookie(state) {
      return `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(OAUTH_STATE_TTL_MS / 1000)}${(process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT_NAME) ? '; Secure' : ''}`;
    },

    clearOAuthStateCookie() {
      return `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${(process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT_NAME) ? '; Secure' : ''}`;
    },

    sessionCookie(token) {
      return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${(process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT_NAME) ? '; Secure' : ''}`;
    },

    clearSessionCookie() {
      return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${(process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT_NAME) ? '; Secure' : ''}`;
    },
  };
}

export { PASSWORD_MIN_LENGTH, SESSION_COOKIE, configuredAdminEmails, isAdminEmail, normalizeEmail, validEmail };
