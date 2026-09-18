import express from 'express';
import fs from 'node:fs/promises';
import mammoth from 'mammoth';
import multer from 'multer';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { fileURLToPath } from 'node:url';
import { createSettingsStore, PROVIDERS, modelsForProvider, normalizeProvider, normalizeCustomProvider, normalizeCustomSearchSources, MAX_CUSTOM_SEARCH_SOURCES } from './settings.js';
import { createProfileStore } from './profiles.js';
import { createAuthStore } from './auth.js';
import { SEARCH_SOURCES, SEARCH_SOURCE_IDS } from '../shared/search-sources.js';
import { canonicalJobUrl, extractJobLeads } from '../shared/jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const store = createSettingsStore(rootDir);
const profileStore = createProfileStore(rootDir);
const authStore = createAuthStore(rootDir);
const app = express();
const port = Number(process.env.PORT) || 8787;
// Railway routes traffic to the container network interface. Keep local runs
// bound to loopback, but expose the listener when Railway provides its
// deployment environment variables.
const host = process.env.HOST || (process.env.RAILWAY_ENVIRONMENT_NAME ? '0.0.0.0' : '127.0.0.1');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const commandNames = new Set([
  'setup-candidate',
  'build-search-config',
  'find-me-a-job',
  'add-job',
  'write-cover-letter',
  'interview-prep',
  'mark-submitted',
  'job-stats',
  'export-resume',
]);

app.use(express.json({ limit: '100mb' }));

function apiError(error, fallback = 'Request failed') {
  const status = Number(error?.status || error?.response?.status) || 500;
  const provider = error?.provider || error?.error?.metadata?.provider_name;
  const message = error?.error?.message || error?.message || fallback;
  return { status, body: { error: { message, provider, status } } };
}

const FETCH_TIMEOUT_MS = 12000;
const FETCH_MAX_BYTES = 2_000_000;
const OPENROUTER_TIMEOUT_MS = 90_000;
const JOB_SEARCH_PROVIDER_TIMEOUT_MS = 240_000;
const ROUTERA_PRICE_PER_MILLION = 1_000_000;

export function normalizeRouteraPrice(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount / ROUTERA_PRICE_PER_MILLION : 0;
}

function isPrivateAddress(address) {
  const normalized = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '0.0.0.0') return true;
  if (net.isIPv4(normalized)) {
    const [a, b] = normalized.split('.').map(Number);
    return a === 0 || a === 10 || a === 100 && b >= 64 && b <= 127 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(normalized)) {
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice(7);
      const mappedV4 = net.isIPv4(mapped) ? mapped : mapped.split(':').slice(-2).map((part) => Number.parseInt(part, 16)).flatMap((part) => [part >> 8, part & 255]).join('.');
      return isPrivateAddress(mappedV4);
    }
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('ff');
  }
  return false;
}

async function assertPublicUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS posting URLs are supported.');
  if (isPrivateAddress(url.hostname)) throw new Error('Posting URL points to a private network address.');
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('Posting URL points to a private network address.');
  return url;
}

async function requestPinned(url, signal) {
  const addresses = await Promise.race([
    dns.lookup(url.hostname, { all: true, verbatim: true }),
    new Promise((_, reject) => {
      if (signal?.aborted) reject(new DOMException('The request was cancelled.', 'AbortError'));
      else signal?.addEventListener('abort', () => reject(new DOMException('The request was cancelled.', 'AbortError')), { once: true });
    }),
  ]);
  const address = addresses.find(({ address }) => !isPrivateAddress(address));
  if (!address) throw new Error('Posting URL points to a private network address.');
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request({
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      headers: { 'User-Agent': 'Hire-Me-Agents/1.0 (job search)' },
      servername: url.hostname,
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [{ address: address.address, family: net.isIPv6(address.address) ? 6 : 4 }])
        : callback(null, address.address, net.isIPv6(address.address) ? 6 : 4),
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > FETCH_MAX_BYTES) { request.destroy(new Error('Response exceeded the 2 MB limit.')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode || 0, headers: response.headers, ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300, html: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('error', reject);
    const abort = () => request.destroy(new DOMException('The request was cancelled.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    request.setTimeout(FETCH_TIMEOUT_MS, () => request.destroy(new Error('Request timed out.')));
    request.on('close', () => signal?.removeEventListener('abort', abort));
    request.end();
  });
}

function normalizeCustomSite(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) return null;
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

async function fetchCustomSite(url, { signal } = {}) {
  if (signal?.aborted) return { url, status: 0, ok: false, text: 'Fetch cancelled.' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const safeUrl = await assertPublicUrl(url);
    const response = await requestPinned(safeUrl, controller.signal);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location) throw new Error(`Redirect response ${response.status} had no location.`);
      const redirectedUrl = await assertPublicUrl(new URL(location, safeUrl).toString());
      const redirected = await requestPinned(redirectedUrl, controller.signal);
      if (redirected.status >= 300 && redirected.status < 400) throw new Error('Multiple redirects are not followed.');
      return parseFetchedSite(redirectedUrl.toString(), redirected, redirected.html);
    }
    return parseFetchedSite(safeUrl.toString(), response, response.html);
  } catch (error) {
    return { url, status: 0, ok: false, text: `Fetch failed: ${error.name === 'AbortError' ? 'timed out or cancelled' : error.message}` };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

function parseFetchedSite(url, response, html) {
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12000);
    const links = [...html.matchAll(/href=["']([^"']+)["']/gi)]
      .map((match) => { try { return new URL(match[1], url).toString(); } catch { return null; } })
      .filter((link, index, all) => link && all.indexOf(link) === index)
      .filter((link) => /^https?:\/\//i.test(link))
      .slice(0, 20);
    const jobLinks = links.filter((link) => /(?:job|jobs|vacanc|career|position|opportunit|opening|role|employment|duty|closing|recruit)/i.test(link));
    return { url, status: response.status, ok: response.ok, text, links, jobLinks };
}


async function mapWithConcurrency(items, limit, worker, signal) {
  const results = new Array(items.length);
  let next = 0;
  async function consume() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      if (signal?.aborted) return;
      try { results[index] = await worker(items[index], index); }
      catch (error) { results[index] = { error }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, consume));
  return results;
}

function providerError(provider, model, status, detail = '') {
  const statusDetail = status ? ` (HTTP ${status})` : '';
  const error = new Error(`${PROVIDERS[provider]?.label || provider} request failed for ${model || 'the selected model'}${statusDetail}${detail ? `: ${detail.slice(0, 240)}` : ''}`);
  error.status = status || 502;
  error.provider = provider;
  return error;
}

function safeProviderDetail(data) {
  const message = typeof data?.error?.message === 'string' ? data.error.message : typeof data?.message === 'string' ? data.message : '';
  return message.replace(/\b(?:sk-or-v1-|sk-|AIza|key-)[a-z0-9._-]{8,}\b/gi, '[redacted]');
}

async function fetchProvider(url, { provider, model, headers = {}, body, signal, method = 'POST', redirect = 'follow', timeoutMs = OPENROUTER_TIMEOUT_MS } = {}) {
  if (signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const timeoutController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);
    const abortFromCaller = () => timeoutController.abort();
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    try {
      const response = await fetch(url, { method, body, signal: timeoutController.signal, headers, redirect });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const status = response.status;
        const retryable = [408, 425, 429, 500, 502, 503, 504].includes(status);
        if (attempt === 0 && retryable) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
        // Do not expose a provider response body: it may echo request content or secrets.
        throw providerError(provider, model, status, safeProviderDetail(data));
      }
      return data;
    } catch (error) {
      if (error?.provider === provider) throw error;
      if (timedOut && error.name === 'AbortError') throw providerError(provider, model, 504, `Timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      if (signal?.aborted && error.name === 'AbortError') throw new DOMException('The request was cancelled.', 'AbortError');
      const retryable = error instanceof TypeError || [408, 425, 429, 500, 502, 503, 504].includes(error.status);
      if (attempt === 0 && retryable && !signal?.aborted) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
      if (error.name === 'AbortError') throw error;
      throw providerError(provider, model, error.status, error.message);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}

function normalizeDirectResponse(provider, model, data) {
  if (provider === 'claude') {
    const content = (data.content || []).filter((part) => part?.type === 'text').map((part) => part.text).join('');
    return { id: data.id, model: data.model || model, choices: [{ message: { role: 'assistant', content }, finish_reason: data.stop_reason || null }], usage: data.usage ? { prompt_tokens: data.usage.input_tokens, completion_tokens: data.usage.output_tokens, total_tokens: Number(data.usage.input_tokens || 0) + Number(data.usage.output_tokens || 0) } : null };
  }
  if (provider === 'gemini') {
    const content = (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('');
    const usage = data.usageMetadata;
    return { model, choices: [{ message: { role: 'assistant', content }, finish_reason: data.candidates?.[0]?.finishReason || null }], usage: usage ? { prompt_tokens: usage.promptTokenCount, completion_tokens: usage.candidatesTokenCount, total_tokens: usage.totalTokenCount } : null };
  }
  return data;
}

async function providerRequest(pathname, options = {}) {
  if (options.signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
  const { userId = '', ...requestOptions } = options;
  const settings = await store.get({ includeSecret: true, userId });
  const provider = settings.provider;
  const model = settings.model;
  const key = settings.apiKey;
  if (!key) {
    const error = new Error(`Add a ${PROVIDERS[provider]?.label || provider} API key in Settings first.`);
    error.status = 400;
    error.provider = provider;
    throw error;
  }
  const headers = { 'Content-Type': 'application/json', ...(requestOptions.headers || {}) };
  const bodyData = typeof requestOptions.body === 'string' ? JSON.parse(requestOptions.body) : requestOptions.body;
  const safeBody = { ...bodyData };
  delete safeBody.tools;
  if (provider === 'openrouter') {
    headers.Authorization = `Bearer ${key}`;
    headers['HTTP-Referer'] = process.env.APP_ORIGIN || 'http://localhost:5173';
    headers['X-Title'] = 'Hire Me Agents';
    const data = await fetchProvider(`https://openrouter.ai/api/v1${pathname}`, { provider, model, ...requestOptions, headers, body: typeof requestOptions.body === 'string' ? requestOptions.body : requestOptions.body ? JSON.stringify(requestOptions.body) : undefined });
    return data;
  }
  if (provider === 'custom') {
    const customProvider = normalizeCustomProvider(settings.customProvider, { strict: true });
    if (!customProvider) throw providerError(provider, model, 400, 'Complete the custom provider name, base URL, and model in Settings first.');
    const baseUrl = await assertPublicUrl(customProvider.baseUrl);
    headers.Authorization = `Bearer ${key}`;
    return fetchProvider(`${baseUrl.toString().replace(/\/$/, '')}${pathname}`, { provider, model, ...requestOptions, headers, body: JSON.stringify(safeBody), redirect: 'manual' });
  }
  if (pathname !== '/chat/completions') throw providerError(provider, model, 400, 'This provider does not expose a model catalog through this endpoint.');
  const messages = Array.isArray(bodyData?.messages) ? bodyData.messages : [];
  if (provider === 'claude') {
    const system = messages.filter((message) => message.role === 'system').map((message) => String(message.content || '')).join('\n\n');
    const converted = messages.filter((message) => message.role !== 'system').map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: String(message.content || '') }));
    const payload = { model, max_tokens: safeBody.max_tokens || settings.maxTokens, temperature: safeBody.temperature ?? settings.temperature, messages: converted };
    if (system) payload.system = system;
    const data = await fetchProvider('https://api.anthropic.com/v1/messages', { provider, model, ...requestOptions, headers: { ...headers, 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(payload) });
    return normalizeDirectResponse(provider, model, data);
  }
  if (provider === 'gemini') {
    const contents = messages.filter((message) => message.role !== 'system').map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(message.content || '') }] }));
    const system = messages.filter((message) => message.role === 'system').map((message) => String(message.content || '')).join('\n\n');
    const payload = { contents, generationConfig: { temperature: safeBody.temperature ?? settings.temperature, maxOutputTokens: safeBody.max_tokens || settings.maxTokens } };
    if (system) payload.systemInstruction = { parts: [{ text: system }] };
    const data = await fetchProvider(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { provider, model, ...requestOptions, headers: { ...headers, 'x-goog-api-key': key }, body: JSON.stringify(payload) });
    return normalizeDirectResponse(provider, model, data);
  }
  const base = provider === 'kimi'
    ? (process.env.KIMI_API_BASE_URL || 'https://api.moonshot.ai/v1')
    : provider === 'deepseek'
      ? (process.env.DEEPSEEK_API_BASE_URL || 'https://api.deepseek.com/v1')
      : provider === 'routera'
        ? (process.env.ROUTERA_API_BASE_URL || 'https://api.routera.one/v1')
      : 'https://api.openai.com/v1';
  headers.Authorization = `Bearer ${key}`;
  return fetchProvider(`${base}${pathname}`, { provider, model, ...requestOptions, headers, body: JSON.stringify(safeBody) });
}

// Kept as a compatibility alias for workflow call sites and older integrations.
const openRouterRequest = providerRequest;
app.get('/api/health', (_req, res) => res.json({ ok: true }));

function authError(error, fallback = 'Authentication failed') {
  const status = Number(error?.status) || 500;
  return res => res.status(status).json({ error: { message: error?.message || fallback } });
}

function setSession(res, token) {
  res.setHeader('Set-Cookie', authStore.sessionCookie(token));
}

function requestOrigin(req) {
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  const protocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${protocol}://${req.headers.host || `localhost:${port}`}`;
}

function googleRedirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || `${requestOrigin(req)}/api/auth/google/callback`;
}

async function fetchGoogleUser(code, redirectUri) {
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const tokenData = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenData.access_token) throw new Error('Google sign-in could not be completed.');
  const userResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const userData = await userResponse.json().catch(() => ({}));
  if (!userResponse.ok || !userData.sub || !userData.email || userData.email_verified !== true) throw new Error('Google did not return a verified email account.');
  return { sub: String(userData.sub), email: String(userData.email) };
}

app.get('/api/auth/config', async (_req, res) => {
  res.json(await authStore.config());
});

app.get('/api/auth/me', async (req, res) => {
  const user = await authStore.getUserForToken(authStore.parseSessionCookie(req));
  if (!user) return res.status(401).json({ error: { message: 'Not signed in.' } });
  res.json({ user });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const result = await authStore.register(req.body?.email, req.body?.password);
    setSession(res, result.token);
    res.status(201).json({ user: result.user });
  } catch (error) {
    authError(error)(res);
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const result = await authStore.login(req.body?.email, req.body?.password);
    setSession(res, result.token);
    res.json({ user: result.user });
  } catch (error) {
    authError(error, 'Invalid email or password.')(res);
  }
});

app.post('/api/auth/logout', async (req, res) => {
  await authStore.logout(authStore.parseSessionCookie(req));
  res.setHeader('Set-Cookie', authStore.clearSessionCookie());
  res.json({ ok: true });
});

app.get('/api/auth/google/start', async (req, res) => {
  if (!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)) {
    return res.status(503).json({ error: { message: 'Google sign-in is not configured. Use an email and password account.' } });
  }
  const state = randomState();
  const redirectUri = googleRedirectUri(req);
  await authStore.beginGoogle(state, redirectUri);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' }).toString();
  res.setHeader('Set-Cookie', authStore.oauthStateCookie(state));
  res.redirect(url.toString());
});

app.get('/api/auth/google/callback', async (req, res) => {
  const errorRedirect = `${requestOrigin(req)}/?authError=`;
  try {
    if (req.query.error) throw new Error('Google sign-in was cancelled.');
    const stateValue = String(req.query.state || '');
    if (!stateValue || stateValue !== authStore.parseOAuthStateCookie(req)) throw new Error('Google sign-in state was invalid. Please try again.');
    const state = await authStore.consumeGoogleState(stateValue);
    if (!state) throw new Error('Google sign-in expired. Please try again.');
    const googleUser = await fetchGoogleUser(String(req.query.code || ''), state.redirectUri);
    const result = await authStore.loginGoogle(googleUser);
    res.setHeader('Set-Cookie', [authStore.clearOAuthStateCookie(), authStore.sessionCookie(result.token)]);
    res.redirect(`${requestOrigin(req)}/?auth=success`);
  } catch (error) {
    res.setHeader('Set-Cookie', authStore.clearOAuthStateCookie());
    res.redirect(`${errorRedirect}${encodeURIComponent(error.message || 'Google sign-in failed.')}`);
  }
});

function randomState() {
  return crypto.randomBytes(24).toString('base64url');
}

async function requireAuth(req, res, next) {
  try {
    const user = await authStore.getUserForToken(authStore.parseSessionCookie(req));
    if (!user) return res.status(401).json({ error: { message: 'Sign in required.' } });
    req.user = user;
    next();
  } catch (error) {
    res.status(500).json({ error: { message: 'Authentication service unavailable.' } });
  }
}

app.use('/api', requireAuth);

app.get('/api/profiles', async (req, res) => {
  try {
    res.json(await profileStore.get({ userId: req.user.id }));
  } catch (error) {
    const result = apiError(error, 'Could not load profiles');
    res.status(result.status).json(result.body);
  }
});

app.put('/api/profiles', async (req, res) => {
  try {
    res.json(await profileStore.replace(req.body, { userId: req.user.id }));
  } catch (error) {
    const result = apiError(error, 'Could not save profiles');
    res.status(result.status).json(result.body);
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    res.json(await store.get({ userId: req.user.id }));
  } catch (error) {
    const result = apiError(error, 'Could not load settings');
    res.status(result.status).json(result.body);
  }
});

app.put('/api/settings', async (req, res) => {
  const provider = normalizeProvider(req.body.provider);
  const model = String(req.body.model || '').trim();
  const temperature = Number(req.body.temperature);
  const maxTokens = Number(req.body.maxTokens);
  const searchSources = Array.isArray(req.body.searchSources) ? [...new Set(req.body.searchSources.map(String))] : [];
  const customSourcesProvided = req.body.customSearchSources !== undefined;
  const customSearchSources = customSourcesProvided ? normalizeCustomSearchSources(req.body.customSearchSources, { strict: true }) : null;
  const searchCountry = String(req.body.searchCountry || '').trim();
  const customProvider = provider === 'custom' ? normalizeCustomProvider(req.body.customProvider, { strict: true }) : undefined;
  const validDirectModel = modelsForProvider(provider).some((entry) => entry.id === model);
  const validRouteraModel = provider === 'routera' && /^[a-z0-9._:-]+\/[a-z0-9._:@/-]+$/i.test(model);
  const validCustomModel = provider === 'custom' && customProvider?.model === model;
  const modelIsValid = provider === 'openrouter'
    ? /^~?[a-z0-9._-]+\/[a-z0-9._:@/-]+$/i.test(model)
    : provider === 'custom'
      ? validCustomModel
      : provider === 'routera'
        ? validRouteraModel
        : validDirectModel;
  if (!modelIsValid) {
    return res.status(400).json({ error: { message: `Choose a valid ${PROVIDERS[provider].label} model.` } });
  }
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) return res.status(400).json({ error: { message: 'Temperature must be between 0 and 2.' } });
  if (!Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 32768) return res.status(400).json({ error: { message: 'Max output tokens must be between 128 and 32768.' } });
  if (customSourcesProvided && !customSearchSources) return res.status(400).json({ error: { message: `Custom search sources must be valid HTTP or HTTPS URLs, with a maximum of ${MAX_CUSTOM_SEARCH_SOURCES} entries.` } });
  if (searchCountry.length > 120) return res.status(400).json({ error: { message: 'Country filter must be 120 characters or fewer.' } });
  try {
    const existing = await store.get({ userId: req.user.id });
    const effectiveCustomSources = customSourcesProvided ? customSearchSources : existing.customSearchSources;
    const validSourceIds = new Set([...SEARCH_SOURCE_IDS, ...effectiveCustomSources.map((source) => source.id)]);
    if (!searchSources.length || searchSources.some((source) => !validSourceIds.has(source))) return res.status(400).json({ error: { message: 'Select at least one valid search source.' } });
    res.json(await store.update({ provider, model, temperature, maxTokens, searchSources, searchCountry, customSearchSources: effectiveCustomSources, ...(provider === 'custom' ? { customProvider } : {}), apiKey: req.body.apiKey, clearApiKey: req.body.clearApiKey }, { userId: req.user.id }));
  } catch (error) {
    const result = apiError(error, 'Could not save settings');
    res.status(result.status).json(result.body);
  }
});
app.get('/api/models', async (req, res) => {
  try {
    const settings = await store.get({ userId: req.user.id, includeSecret: true });
    const provider = normalizeProvider(req.query.provider || settings.provider);
    if (provider === 'custom') {
      const customProvider = normalizeCustomProvider(settings.customProvider);
      if (!customProvider) return res.json({ provider, models: [] });
      return res.json({ provider, models: [{ id: customProvider.model, name: customProvider.model, description: `${customProvider.label} model`, contextLength: 0, supportsTools: false }] });
    }
    if (provider === 'routera') {
      const key = settings.providerKeys?.routera || '';
      if (!key) {
        const error = new Error('Add a Routera API key in Settings to load its live model catalog.');
        error.status = 400;
        throw error;
      }
      const payload = await fetchProvider(`${(process.env.ROUTERA_API_BASE_URL || 'https://api.routera.one/v1').replace(/\/$/, '')}/models`, {
        provider: 'routera',
        model: 'model catalog',
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
      });
      const models = (payload.data || [])
        .filter((model) => model?.id)
        .map((model) => ({ id: model.id, name: model.name || model.id, description: model.description || '', contextLength: model.context_length || 0, promptPrice: normalizeRouteraPrice(model.pricing?.prompt), completionPrice: normalizeRouteraPrice(model.pricing?.completion), supportsTools: model.supported_parameters?.includes('tools') || false }));
      return res.json({ provider, models: models.length ? models : modelsForProvider(provider) });
    }
    if (provider !== 'openrouter') return res.json({ provider, models: modelsForProvider(provider) });
    // The model picker can request OpenRouter while another provider is still
    // selected in the unsaved form, so use the OpenRouter key explicitly here.
    const key = settings.providerKeys?.openrouter || '';
    if (!key) {
      const error = new Error('Add an OpenRouter API key in Settings to load its live model catalog.');
      error.status = 400;
      throw error;
    }
    const payload = await fetchProvider('https://openrouter.ai/api/v1/models?output_modalities=text&sort=most-popular', {
      provider: 'openrouter',
      model: 'model catalog',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        'HTTP-Referer': process.env.APP_ORIGIN || 'http://localhost:5173',
        'X-Title': 'Hire Me Agents',
      },
    });
    const models = (payload.data || [])
      .filter((model) => model?.id && model?.architecture?.output_modalities?.includes('text'))
      .map((model) => ({ id: model.id, name: model.name || model.id, description: model.description || '', contextLength: model.context_length || 0, promptPrice: Number(model.pricing?.prompt || 0), completionPrice: Number(model.pricing?.completion || 0), supportsTools: model.supported_parameters?.includes('tools') || false }));
    res.json({ provider, models });
  } catch (error) {
    const result = apiError(error, 'Could not load the model catalog');
    res.status(result.status).json(result.body);
  }
});
app.post('/api/extract-resume', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: { message: 'Choose a resume file to upload.' } });

  const extension = path.extname(req.file.originalname).toLowerCase();
  const supported = new Set(['.md', '.markdown', '.txt', '.pdf', '.docx']);
  if (!supported.has(extension)) {
    return res.status(415).json({ error: { message: 'Use a Markdown, text, PDF, or DOCX resume.' } });
  }

  try {
    let extractedText = '';
    if (extension === '.pdf') {
      const result = await pdfParse(req.file.buffer);
      extractedText = result.text;
    } else if (extension === '.docx') {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      extractedText = result.value;
    } else {
      extractedText = req.file.buffer.toString('utf8');
    }

    const text = extractedText.replace(/\r\n/g, '\n').trim();
    if (!text) {
      return res.status(422).json({ error: { message: 'No readable text was found in this file.' } });
    }

    res.json({
      filename: req.file.originalname,
      type: extension.slice(1).toUpperCase(),
      characters: text.length,
      text,
    });
  } catch (error) {
    const result = apiError(error, 'The resume could not be read. Try exporting it as PDF or Markdown.');
    res.status(result.status).json(result.body);
  }
});

app.post('/api/test-model', async (req, res) => {
  try {
    const settings = await store.get({ includeSecret: true, userId: req.user.id });
    if (!settings.apiKey) return res.status(400).json({ error: { message: `Add a ${PROVIDERS[settings.provider]?.label || settings.provider} API key first.` } });
    const payload = await openRouterRequest('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: 'user', content: 'Reply with exactly: CONNECTION_OK' }],
        temperature: 0,
        max_tokens: 16,
      }),
      userId: req.user.id,
    });
    res.json({ ok: true, model: payload.model || settings.model });
  } catch (error) {
    const result = apiError(error, 'Model connection failed');
    res.status(result.status).json(result.body);
  }
});

app.post('/api/infer-salary', async (req, res) => {
  const resumeText = String(req.body.resumeText || '').trim();
  const searchConfig = String(req.body.searchConfig || '').trim();
  if (!resumeText && !searchConfig) return res.status(400).json({ error: { message: 'Add a CV or complete the search configuration first.' } });
  try {
    const settings = await store.get({ includeSecret: true, userId: req.user.id });
    if (!settings.apiKey) return res.status(400).json({ error: { message: `Add a ${PROVIDERS[settings.provider]?.label || settings.provider} API key in Settings first.` } });
    const payload = await openRouterRequest('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: settings.model,
        temperature: 0,
        max_tokens: 160,
        messages: [
          { role: 'system', content: 'Estimate one realistic minimum annual gross salary expectation in euros for this candidate. Use their location, target market, seniority, and prior search analysis. Ignore US-dollar salary bands when the candidate is targeting Europe. Return JSON only: {"salaryExpectationEur": integer, "basis": "one short sentence"}.' },
          { role: 'user', content: `CV AND PROFILE\n${resumeText.slice(0, 20000)}\n\nPREVIOUS SEARCH ANALYSIS\n${searchConfig.slice(0, 20000)}` },
        ],
      }),
      userId: req.user.id,
    });
    const content = payload.choices?.[0]?.message?.content || '';
    const jsonText = content.match(/\{[\s\S]*?\}/)?.[0];
    const parsed = jsonText ? JSON.parse(jsonText) : {};
    const salaryExpectationEur = Math.round(Number(parsed.salaryExpectationEur));
    if (!Number.isFinite(salaryExpectationEur) || salaryExpectationEur < 10000 || salaryExpectationEur > 1000000) {
      throw new Error('The model did not return a usable euro salary estimate. Enter an amount manually.');
    }
    res.json({ salaryExpectationEur, basis: String(parsed.basis || '').trim() });
  } catch (error) {
    const result = apiError(error, 'Could not estimate salary expectations');
    res.status(result.status).json(result.body);
  }
});

app.post('/api/run-command', async (req, res) => {
  const command = String(req.body.command || '');
  const input = String(req.body.input || '').trim();
  const requestedJobUrl = String(req.body.jobUrl || '').trim();
  const salaryInput = req.body.salaryExpectationEur;
  const salaryExpectationEur = salaryInput === '' || salaryInput == null ? null : Number(salaryInput);
  const candidateSitesInput = Array.isArray(req.body.customSearchSites) ? req.body.customSearchSites : [];
  const candidateSites = [...new Set(candidateSitesInput.map(normalizeCustomSite))];
  if (!commandNames.has(command)) return res.status(400).json({ error: { message: 'Unknown workflow command.' } });
  if (!input) return res.status(400).json({ error: { message: 'Add the command inputs before running.' } });
  if (salaryExpectationEur !== null && (!Number.isFinite(salaryExpectationEur) || salaryExpectationEur < 10000 || salaryExpectationEur > 1000000)) {
    return res.status(400).json({ error: { message: 'Salary expectation must be between €10,000 and €1,000,000 per year.' } });
  }
  if (candidateSitesInput.length > 20 || candidateSites.includes(null)) {
    return res.status(400).json({ error: { message: 'Profile search sites must be valid HTTP or HTTPS domains, with a maximum of 20.' } });
  }
  const requestController = new AbortController();
  const abortRequest = () => requestController.abort();
  res.on('close', () => { if (!res.writableEnded) abortRequest(); });
  try {
    const settings = await store.get({ includeSecret: true, userId: req.user.id });
    if (!settings.apiKey) return res.status(400).json({ error: { message: `Add a ${PROVIDERS[settings.provider]?.label || settings.provider} API key in Settings first.` } });
    if (command === 'find-me-a-job' && settings.provider !== 'openrouter') {
      return res.status(400).json({ error: { message: 'Job search needs OpenRouter because its web-search and page-fetch tools are required. Choose OpenRouter in Settings, or use a direct provider for the other workflows.' } });
    }
    const commandPrompt = await fs.readFile(path.join(rootDir, '.claude', 'commands', `${command}.md`), 'utf8');
    let prompt = commandPrompt;
    const customDefaultSources = settings.customSearchSources || [];
    const configuredSources = [
      ...SEARCH_SOURCES.filter((source) => settings.searchSources.includes(source.id)),
      ...customDefaultSources.filter((source) => settings.searchSources.includes(source.id)),
    ];
    const sourceList = configuredSources.map((source) => `${source.label} (${source.id})${source.url ? ` — ${source.url}` : ''}`).join(', ');
    const countryRule = settings.searchCountry
      ? `COUNTRY FILTER — AUTHORITATIVE: Only include roles located in ${settings.searchCountry}, or explicitly remote roles that clearly accept candidates located in ${settings.searchCountry}. Exclude roles restricted to other countries. If location eligibility is unclear, exclude the role.`
      : 'COUNTRY FILTER: No account-level country restriction is set. Use the candidate profile location and search configuration as additional context.';
    const customSiteList = candidateSites.length ? candidateSites.join(', ') : 'none';
    let customResults = [];
    let sourceResults = [];
    let allAgentResults = [];
    let userInput = input;
    if (command === 'setup-candidate') {
      userInput = `Set up a job-search profile from the resume content below. The resume has already been read, so do not ask for a --resume path. Return the structured profile and recommended next steps directly.\n\n${input}`;
    }
    if (command === 'build-search-config') {
      userInput = `Generate the search configuration from the profile material below. Focus on roles, location, compensation, filters, and priorities. Include a realistic annual gross salary expectation for the candidate's target market as an integer in euros using the field salary_expectation_eur. Search sources are selected separately in Step 3.\n\n${input}`;
    }
    if (command === 'add-job') {
      const jobUrl = requestedJobUrl || '';
      const posting = jobUrl ? await fetchCustomSite(jobUrl, { signal: requestController.signal }) : null;
      const postingEvidence = posting?.ok && posting.text
        ? `LIVE JOB POSTING\nURL: ${jobUrl}\nFetched successfully immediately before analysis.\n\n${posting.text.slice(0, 24000)}`
        : `LIVE JOB POSTING\n${jobUrl ? `The posting could not be fetched (${posting?.text || 'unreachable'}).` : 'No direct posting URL was supplied.'} Use only the saved job summary and CV below, and clearly identify missing evidence.`;
      prompt = `You are a careful job-fit analyst. Do not call or describe tools. Analyze only the candidate evidence and job-posting evidence supplied by the user. Return a concise, practical Markdown report with exactly these sections:\n\n# Role breakdown\nExplain the purpose, seniority, main responsibilities, working arrangement, and compensation when stated.\n\n# What the employer needs\nList the essential requirements and important preferences.\n\n# Compatibility analysis\nUse a table with Requirement, Candidate evidence, and Match (Strong, Partial, or Gap). Never invent candidate experience.\n\n# Why this candidate is compatible\nExplain the strongest evidence-based reasons in plain language.\n\n# Gaps and risks\nIdentify missing or weak evidence and whether each gap appears manageable.\n\n# Application recommendation\nGive a fit score out of 100, a clear Apply / Consider / Skip recommendation, and 3 points the candidate should emphasize when applying.`;
      userInput = `${postingEvidence}\n\nCANDIDATE AND SAVED JOB CONTEXT\n${input}`;
    }
    if (command === 'find-me-a-job') {
      customResults = candidateSites.length
        ? await mapWithConcurrency(candidateSites, 4, (site) => fetchCustomSite(site, { signal: requestController.signal }), requestController.signal)
        : [];
      const defaultSourceResults = await mapWithConcurrency(customDefaultSources.filter((source) => settings.searchSources.includes(source.id)), 4, (source) => fetchCustomSite(source.url, { signal: requestController.signal }), requestController.signal);
      const customEvidence = customResults.map((result) => `SOURCE: ${result.url}\nSTATUS: ${result.status || 'unreachable'}\nLIKELY JOB LINKS: ${(result.jobLinks || []).join(', ') || '(none detected)'}\nPAGE CONTENT: ${result.text || '(no readable content)'}`).join('\n\n');
      const defaultSourceEvidence = defaultSourceResults.map((result) => `SOURCE: ${configuredSources.find((source) => source.url === result.url)?.label || result.url}\nURL: ${result.url}\nSTATUS: ${result.status || 'unreachable'}\nLIKELY JOB LINKS: ${(result.jobLinks || []).join(', ') || '(none detected)'}\nPAGE CONTENT: ${result.text || '(no readable content)'}`).join('\n\n');
      sourceResults = [...defaultSourceResults, ...customResults].map((result) => ({ name: result.url, status: result.ok ? 'fetch-ok' : 'fetch-failed', ...(result.ok ? {} : { error: result.text }) }));
      const salaryRule = salaryExpectationEur === null
        ? 'SALARY RULE: No profile override is set. Use the salary default from the saved search configuration.'
        : `SALARY OVERRIDE — AUTHORITATIVE: Use a minimum annual gross salary of €${Math.round(salaryExpectationEur).toLocaleString('en-IE')} EUR. Ignore and replace every other salary amount or currency found in the saved CV, prior analysis, or search configuration. Do not apply an old USD salary threshold.`;
      userInput = `${salaryRule}\n\n${countryRule}\n\nRun the job search using only these configured sources: ${sourceList}. Also search each profile-specific custom site directly: ${customSiteList}. For every custom domain, use web search with a domain-restricted query for the target roles and use web fetch on likely vacancy links. Do not count a homepage, stylesheet, favicon, or navigation link as a job. Link every reported job and include a sources-searched summary showing each configured source and custom site.\n\nThe server fetched the following saved default custom-source pages just before this request. Treat them as evidence, extract relevant current listings when present, and mark any unreachable source as not searched successfully:\n${defaultSourceEvidence || '(no saved custom sources configured)'}\n\nThe server fetched the following profile-specific custom-site pages just before this request. Treat them as evidence, extract relevant current listings when present, and mark any unreachable source as not searched successfully:\n${customEvidence || '(no profile-specific custom sites configured)'}\n\n${input}`;
    }
    let payload;
    let content;
    let sourceUsage = 0;
    if (command === 'find-me-a-job') {
      const checkedOn = new Date().toISOString().slice(0, 10);
      const sourcePlans = configuredSources.map((source) => ({
        name: source.label,
        domains: source.domains || [],
        instruction: `Search only ${source.label} (${source.id})${source.url ? ` at ${source.url}` : ''}. Use web search with a site restriction, then web fetch the most relevant individual job pages. Follow the source-specific strategy from the command instructions when applicable.`,
      }));
      candidateSites.forEach((site) => sourcePlans.push({
        name: site,
        domains: [new URL(site).hostname],
        instruction: `Search only the custom site ${site}. Use domain-restricted web search for the candidate's target roles, then web fetch individual vacancy pages. Do not count assets, navigation, training courses, or the homepage as jobs.`,
      }));
      const agentResults = await mapWithConcurrency(sourcePlans, 4, async (plan) => {
        try {
        const agentPayload = await openRouterRequest('/chat/completions', {
          method: 'POST',
          signal: requestController.signal,
          timeoutMs: JOB_SEARCH_PROVIDER_TIMEOUT_MS,
          body: JSON.stringify({
            model: settings.model,
            temperature: settings.temperature,
            max_tokens: Math.min(settings.maxTokens, 4096),
            tools: [
              {
                type: 'openrouter:web_search',
                parameters: {
                  engine: 'exa',
                  max_results: 5,
                  max_total_results: 10,
                  search_context_size: 'medium',
                  ...(plan.domains.length ? { allowed_domains: plan.domains } : {}),
                },
              },
              { type: 'openrouter:web_fetch' },
            ],
            stop_server_tools_when: [{ type: 'step_count_is', step_count: 6 }],
            messages: [
              { role: 'system', content: `${prompt}\n\n${countryRule}\n\nToday is ${checkedOn}. You are one focused search agent in a parallel job-search run. Open every individual vacancy with web fetch immediately before reporting it. Exclude search-result snippets, inaccessible pages, expired deadlines, closed/filled roles, talent pools, and pages that no longer accept applications. Return only verified active job leads. Use exactly this structure for every role:\n### [Role title — Company](direct job-posting URL)\n- Posted: YYYY-MM-DD, exact displayed date, or Not stated\n- Closing: YYYY-MM-DD, Open until filled, or Not stated\n- Checked: ${checkedOn}\n- Status: Active\n- Location: city/country or Remote\n- Work mode: Remote, Hybrid, On-site, or Not stated\n- Compensation: exact advertised salary/range and currency, or Not stated\n- Source: job board or employer\n- Evidence: concise summary of responsibilities and the strongest matching requirements from the live posting\nNever report a role without a direct clickable URL and live-page verification. Do not invent dates, compensation, or listings.` },
              { role: 'user', content: `${plan.instruction}\n\nCandidate and search context:\n${userInput}` },
            ],
          }),
          userId: req.user.id,
        });
        sourceUsage += Number(agentPayload.usage?.total_tokens || 0);
        sourceResults.push({ name: plan.name, status: 'agent-complete', note: 'Search agent returned; individual proof pages are checked below.' });
        return `## SEARCH AGENT: ${plan.name}\n${agentPayload.choices?.[0]?.message?.content || 'No result returned.'}`;
        } catch (error) {
          sourceResults.push({ name: plan.name, status: 'agent-failed', error: error.message });
          return `## SEARCH AGENT: ${plan.name}\nSource failed: ${error.message}`;
        }
      }, requestController.signal);
      allAgentResults = agentResults;
      const verified = customResults.map((result) => {
        const links = (result.jobLinks || []).slice(0, 12).map((link) => `- ${link}`).join('\n');
        return `### ${result.url}\n- Fetch status: ${result.ok ? `HTTP ${result.status} (read successfully)` : (result.text || 'unreachable')}\n${links || '- No likely vacancy links detected in the initial page.'}`;
      }).join('\n\n');
      const synthesisInput = `Today is ${checkedOn}. ${countryRule} You are the lead coordinator. Merge these parallel search-agent results into one accurate job-search report for the candidate. Deduplicate by URL or company plus title. Include a role only when its agent opened the direct posting and explicitly confirmed it active on ${checkedOn}. Exclude expired, closed, filled, inaccessible, snippet-only, and unverified roles. Preserve this exact structure for every included role:\n### [Role title — Company](direct job-posting URL)\n- Posted: YYYY-MM-DD, exact displayed date, or Not stated\n- Closing: YYYY-MM-DD, Open until filled, or Not stated\n- Checked: ${checkedOn}\n- Status: Active\n- Location: city/country or Remote\n- Work mode: Remote, Hybrid, On-site, or Not stated\n- Compensation: exact advertised salary/range and currency, or Not stated\n- Source: job board or employer\n- Evidence: concise summary of responsibilities and strongest matching requirements from the live posting\nDo not infer or invent posting dates or compensation. Include totals, qualified leads, excluded stale/unverified results, inaccessible sources, and a source summary. Do not claim a source was searched unless the corresponding agent reported it.\n\n${agentResults.join('\n\n')}\n\n## CONSOLE CUSTOM-SITE FETCH CHECK\n${verified || '- No custom sites configured.'}`;
      try {
      payload = await openRouterRequest('/chat/completions', {
        method: 'POST',
        signal: requestController.signal,
        timeoutMs: JOB_SEARCH_PROVIDER_TIMEOUT_MS,
        body: JSON.stringify({
          model: settings.model,
          temperature: settings.temperature,
          max_tokens: settings.maxTokens,
          messages: [
            { role: 'system', content: `You are the lead coordinator for a job-search console. ${countryRule} Return a useful Markdown report grounded only in the supplied agent results. Every reported role must have a direct URL, an exact or explicitly unavailable posting date, a closing date, a ${checkedOn} verification date, and Status: Active. Never promote an unverified or inactive vacancy into the report.` },
            { role: 'user', content: synthesisInput },
          ],
        }),
        userId: req.user.id,
      });
      content = payload.choices?.[0]?.message?.content || '';
      } catch (error) {
        if (error.name === 'AbortError' && requestController.signal.aborted) throw error;
        content = agentResults.filter(Boolean).join('\n\n');
        payload = { model: settings.model, usage: null };
        sourceResults.push({ name: 'Lead synthesis', status: 'fallback', error: error.message });
      }
    } else {
      payload = await openRouterRequest('/chat/completions', {
        method: 'POST',
        signal: requestController.signal,
        body: JSON.stringify({
          model: settings.model,
          temperature: settings.temperature,
          max_tokens: settings.maxTokens,
          messages: [
            { role: 'system', content: `${prompt}\n\nYou are running inside the Hire Me Agents web console. Return the useful artifact directly in Markdown. Do not claim to have read, written, fetched, or searched anything you were not given in the user message.` },
            { role: 'user', content: userInput },
          ],
        }),
        userId: req.user.id,
      });
      content = payload.choices?.[0]?.message?.content || '';
    }
    const sourceUsageTotal = command === 'find-me-a-job' ? (sourceUsage || 0) : 0;
    const totalTokens = Number(payload.usage?.total_tokens || 0) + sourceUsageTotal;
    const jobs = command === 'find-me-a-job'
      ? (await mapWithConcurrency([...new Map(allAgentResults.flatMap((result) => extractJobLeads(result || '')).map((job) => [job.canonicalUrl || canonicalJobUrl(job.url), job])).values()].slice(0, 100), 4, async (job) => {
        const page = await fetchCustomSite(job.url, { signal: requestController.signal });
        return {
          ...job,
          status: 'Unverified',
          verificationStatus: 'unverified',
          canonicalUrl: job.canonicalUrl || canonicalJobUrl(job.url),
          verification: {
            status: page.ok ? 'page-fetched' : 'unavailable',
            checkedAt: new Date().toISOString(),
            url: page.url || job.url,
            httpStatus: page.status || 0,
            excerpt: String(page.text || '').slice(0, 500),
          },
        };
      }, requestController.signal)).filter(Boolean)
      : [];
    res.json({
      content,
      model: payload.model || settings.model,
      usage: payload.usage ? { ...payload.usage, total_tokens: totalTokens, source_total_tokens: sourceUsageTotal } : (sourceUsageTotal ? { total_tokens: sourceUsageTotal, source_total_tokens: sourceUsageTotal } : null),
      jobs,
      sourceResults,
    });
  } catch (error) {
    const result = apiError(error, 'Agent run failed');
    res.status(result.status).json(result.body);
  } finally {
    // The response close handler is intentionally one-way; completed responses do not abort work.
  }
});

app.post('/api/summarize-job', async (req, res) => {
  const url = String(req.body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: { message: 'A valid job posting URL is required.' } });
  try {
    const settings = await store.get({ includeSecret: true, userId: req.user.id });
    if (!settings.apiKey) return res.status(400).json({ error: { message: `Add a ${PROVIDERS[settings.provider]?.label || settings.provider} API key in Settings first.` } });
    const page = await fetchCustomSite(url);
    if (!page.ok || !page.text) throw new Error(`Could not read the job posting (HTTP ${page.status || 'unreachable'}).`);
    const payload = await openRouterRequest('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          { role: 'system', content: 'Summarize a job posting accurately and concisely. Return 4-6 bullet points covering the role, key responsibilities, required skills, location/work mode, and compensation only when stated. Do not invent missing details.' },
          { role: 'user', content: `Job posting URL: ${url}\n\nPage text:\n${page.text.slice(0, 18000)}` },
        ],
      }),
      userId: req.user.id,
    });
    res.json({ summary: payload.choices?.[0]?.message?.content || '' });
  } catch (error) {
    const result = apiError(error, 'Could not summarize the job posting');
    res.status(result.status).json(result.body);
  }
});

const distDir = path.join(rootDir, 'dist');
app.use(express.static(distDir));
app.get('/*splat', async (_req, res, next) => {
  try {
    await fs.access(path.join(distDir, 'index.html'));
    res.sendFile(path.join(distDir, 'index.html'));
  } catch {
    next();
  }
});

app.use((error, _req, res, next) => {
  if (!(error instanceof multer.MulterError)) return next(error);
  const message = error.code === 'LIMIT_FILE_SIZE' ? 'The resume must be smaller than 10 MB.' : error.message;
  res.status(400).json({ error: { message } });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, host, () => {
    console.log(`Hire Me Agents API listening on http://${host}:${port}`);
  });
}

export { app, apiError, assertPublicUrl, isPrivateAddress };
