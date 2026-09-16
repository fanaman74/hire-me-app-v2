import express from 'express';
import fs from 'node:fs/promises';
import mammoth from 'mammoth';
import multer from 'multer';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { fileURLToPath } from 'node:url';
import { createSettingsStore } from './settings.js';
import { createProfileStore } from './profiles.js';
import { SEARCH_SOURCES, SEARCH_SOURCE_IDS } from '../shared/search-sources.js';
import { canonicalJobUrl, extractJobLeads } from '../shared/jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const store = createSettingsStore(rootDir);
const profileStore = createProfileStore(rootDir);
const app = express();
const port = Number(process.env.PORT) || 8787;
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

async function openRouterRequest(pathname, options = {}) {
  if (options.signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
  const settings = await store.get({ includeSecret: true });
  const headers = {
    'Content-Type': 'application/json',
    'HTTP-Referer': 'http://localhost:5173',
    'X-Title': 'Hire Me Agents',
    ...(options.headers || {}),
  };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  const signal = options.signal;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), OPENROUTER_TIMEOUT_MS);
    const abortFromCaller = () => timeoutController.abort();
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    try {
      const response = await fetch(`https://openrouter.ai/api/v1${pathname}`, { ...options, signal: timeoutController.signal, headers });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data?.error?.message || `OpenRouter returned ${response.status}`);
        error.status = response.status;
        error.error = data.error;
        if (attempt === 0 && [408, 425, 429, 500, 502, 503, 504].includes(response.status)) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
        throw error;
      }
      return data;
    } catch (error) {
      const retryable = error instanceof TypeError || [408, 425, 429, 500, 502, 503, 504].includes(error.status);
      if (attempt === 0 && retryable && !signal?.aborted) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/profiles', async (_req, res) => {
  try {
    res.json(await profileStore.get());
  } catch (error) {
    const result = apiError(error, 'Could not load profiles');
    res.status(result.status).json(result.body);
  }
});

app.put('/api/profiles', async (req, res) => {
  try {
    res.json(await profileStore.replace(req.body));
  } catch (error) {
    const result = apiError(error, 'Could not save profiles');
    res.status(result.status).json(result.body);
  }
});

app.get('/api/settings', async (_req, res) => {
  try {
    res.json(await store.get());
  } catch (error) {
    const result = apiError(error, 'Could not load settings');
    res.status(result.status).json(result.body);
  }
});

app.put('/api/settings', async (req, res) => {
  const model = String(req.body.model || '').trim();
  const temperature = Number(req.body.temperature);
  const maxTokens = Number(req.body.maxTokens);
  const searchSources = Array.isArray(req.body.searchSources) ? [...new Set(req.body.searchSources.map(String))] : [];
  if (!/^[a-z0-9._-]+\/[a-z0-9._:@/-]+$/i.test(model)) {
    return res.status(400).json({ error: { message: 'Choose a valid OpenRouter model slug.' } });
  }
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    return res.status(400).json({ error: { message: 'Temperature must be between 0 and 2.' } });
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 32768) {
    return res.status(400).json({ error: { message: 'Max output tokens must be between 128 and 32768.' } });
  }
  if (!searchSources.length || searchSources.some((source) => !SEARCH_SOURCE_IDS.has(source))) {
    return res.status(400).json({ error: { message: 'Select at least one valid built-in search source.' } });
  }
  try {
    res.json(await store.update({
      model,
      temperature,
      maxTokens,
      searchSources,
      apiKey: req.body.apiKey,
      clearApiKey: req.body.clearApiKey,
    }));
  } catch (error) {
    const result = apiError(error, 'Could not save settings');
    res.status(result.status).json(result.body);
  }
});

app.get('/api/models', async (_req, res) => {
  try {
    const payload = await openRouterRequest('/models?output_modalities=text&sort=most-popular');
    const models = (payload.data || [])
      .filter((model) => model?.id && model?.architecture?.output_modalities?.includes('text'))
      .map((model) => ({
        id: model.id,
        name: model.name || model.id,
        description: model.description || '',
        contextLength: model.context_length || 0,
        promptPrice: Number(model.pricing?.prompt || 0),
        completionPrice: Number(model.pricing?.completion || 0),
        supportsTools: model.supported_parameters?.includes('tools') || false,
      }));
    res.json({ models });
  } catch (error) {
    const result = apiError(error, 'Could not load the OpenRouter model catalog');
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

app.post('/api/test-model', async (_req, res) => {
  try {
    const settings = await store.get({ includeSecret: true });
    if (!settings.apiKey) return res.status(400).json({ error: { message: 'Add an OpenRouter API key first.' } });
    const payload = await openRouterRequest('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: 'user', content: 'Reply with exactly: CONNECTION_OK' }],
        temperature: 0,
        max_tokens: 16,
      }),
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
    const settings = await store.get({ includeSecret: true });
    if (!settings.apiKey) return res.status(400).json({ error: { message: 'Add an OpenRouter API key in Settings first.' } });
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
    const settings = await store.get({ includeSecret: true });
    if (!settings.apiKey) return res.status(400).json({ error: { message: 'Add an OpenRouter API key in Settings first.' } });
    const commandPrompt = await fs.readFile(path.join(rootDir, '.claude', 'commands', `${command}.md`), 'utf8');
    let prompt = commandPrompt;
    const configuredSources = SEARCH_SOURCES.filter((source) => settings.searchSources.includes(source.id));
    const sourceList = configuredSources.map((source) => `${source.label} (${source.id})`).join(', ');
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
      const customEvidence = customResults.map((result) => `SOURCE: ${result.url}\nSTATUS: ${result.status || 'unreachable'}\nLIKELY JOB LINKS: ${(result.jobLinks || []).join(', ') || '(none detected)'}\nPAGE CONTENT: ${result.text || '(no readable content)'}`).join('\n\n');
      sourceResults = customResults.map((result) => ({ name: result.url, status: result.ok ? 'fetch-ok' : 'fetch-failed', ...(result.ok ? {} : { error: result.text }) }));
      const salaryRule = salaryExpectationEur === null
        ? 'SALARY RULE: No profile override is set. Use the salary default from the saved search configuration.'
        : `SALARY OVERRIDE — AUTHORITATIVE: Use a minimum annual gross salary of €${Math.round(salaryExpectationEur).toLocaleString('en-IE')} EUR. Ignore and replace every other salary amount or currency found in the saved CV, prior analysis, or search configuration. Do not apply an old USD salary threshold.`;
      userInput = `${salaryRule}\n\nRun the job search using only these configured sources: ${sourceList}. Also search each custom site directly: ${customSiteList}. For every custom domain, use web search with a domain-restricted query for the target roles and use web fetch on likely vacancy links. Do not count a homepage, stylesheet, favicon, or navigation link as a job. Link every reported job and include a sources-searched summary showing each configured source and custom site.\n\nThe server fetched the following custom-site pages just before this request. Treat them as evidence, extract relevant current listings when present, and mark any unreachable source as not searched successfully:\n${customEvidence || '(no custom sites configured)'}\n\n${input}`;
    }
    let payload;
    let content;
    let sourceUsage = 0;
    if (command === 'find-me-a-job') {
      const checkedOn = new Date().toISOString().slice(0, 10);
      const sourcePlans = configuredSources.map((source) => ({
        name: source.label,
        instruction: `Search only ${source.label} (${source.id}). Use web search with a site restriction, then web fetch the most relevant individual job pages. Follow the source-specific strategy from the command instructions when applicable.`,
      }));
      candidateSites.forEach((site) => sourcePlans.push({
        name: site,
        instruction: `Search only the custom site ${site}. Use domain-restricted web search for the candidate's target roles, then web fetch individual vacancy pages. Do not count assets, navigation, training courses, or the homepage as jobs.`,
      }));
      const agentResults = await mapWithConcurrency(sourcePlans, 4, async (plan) => {
        try {
        const agentPayload = await openRouterRequest('/chat/completions', {
          method: 'POST',
          signal: requestController.signal,
          body: JSON.stringify({
            model: settings.model,
            temperature: settings.temperature,
            max_tokens: Math.min(settings.maxTokens, 4096),
            tools: [{ type: 'openrouter:web_search' }, { type: 'openrouter:web_fetch' }],
            messages: [
              { role: 'system', content: `${prompt}\n\nToday is ${checkedOn}. You are one focused search agent in a parallel job-search run. Open every individual vacancy with web fetch immediately before reporting it. Exclude search-result snippets, inaccessible pages, expired deadlines, closed/filled roles, talent pools, and pages that no longer accept applications. Return only verified active job leads. Use exactly this structure for every role:\n### [Role title — Company](direct job-posting URL)\n- Posted: YYYY-MM-DD, exact displayed date, or Not stated\n- Closing: YYYY-MM-DD, Open until filled, or Not stated\n- Checked: ${checkedOn}\n- Status: Active\n- Location: city/country or Remote\n- Work mode: Remote, Hybrid, On-site, or Not stated\n- Compensation: exact advertised salary/range and currency, or Not stated\n- Source: job board or employer\n- Evidence: concise summary of responsibilities and the strongest matching requirements from the live posting\nNever report a role without a direct clickable URL and live-page verification. Do not invent dates, compensation, or listings.` },
              { role: 'user', content: `${plan.instruction}\n\nCandidate and search context:\n${userInput}` },
            ],
          }),
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
      const synthesisInput = `Today is ${checkedOn}. You are the lead coordinator. Merge these parallel search-agent results into one accurate job-search report for the candidate. Deduplicate by URL or company plus title. Include a role only when its agent opened the direct posting and explicitly confirmed it active on ${checkedOn}. Exclude expired, closed, filled, inaccessible, snippet-only, and unverified roles. Preserve this exact structure for every included role:\n### [Role title — Company](direct job-posting URL)\n- Posted: YYYY-MM-DD, exact displayed date, or Not stated\n- Closing: YYYY-MM-DD, Open until filled, or Not stated\n- Checked: ${checkedOn}\n- Status: Active\n- Location: city/country or Remote\n- Work mode: Remote, Hybrid, On-site, or Not stated\n- Compensation: exact advertised salary/range and currency, or Not stated\n- Source: job board or employer\n- Evidence: concise summary of responsibilities and strongest matching requirements from the live posting\nDo not infer or invent posting dates or compensation. Include totals, qualified leads, excluded stale/unverified results, inaccessible sources, and a source summary. Do not claim a source was searched unless the corresponding agent reported it.\n\n${agentResults.join('\n\n')}\n\n## CONSOLE CUSTOM-SITE FETCH CHECK\n${verified || '- No custom sites configured.'}`;
      try {
      payload = await openRouterRequest('/chat/completions', {
        method: 'POST',
        signal: requestController.signal,
        body: JSON.stringify({
          model: settings.model,
          temperature: settings.temperature,
          max_tokens: settings.maxTokens,
          messages: [
            { role: 'system', content: `You are the lead coordinator for a job-search console. Return a useful Markdown report grounded only in the supplied agent results. Every reported role must have a direct URL, an exact or explicitly unavailable posting date, a closing date, a ${checkedOn} verification date, and Status: Active. Never promote an unverified or inactive vacancy into the report.` },
            { role: 'user', content: synthesisInput },
          ],
        }),
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
    const settings = await store.get({ includeSecret: true });
    if (!settings.apiKey) return res.status(400).json({ error: { message: 'Add an OpenRouter API key in Settings first.' } });
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
  app.listen(port, '127.0.0.1', () => {
    console.log(`Hire Me Agents API listening on http://127.0.0.1:${port}`);
  });
}

export { app, apiError, assertPublicUrl, isPrivateAddress };
