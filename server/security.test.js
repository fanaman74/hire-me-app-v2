import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { extractJobLeads, jobsFromSearchResult } from '../shared/jobs.js';

process.env.NODE_ENV = 'test';
process.env.OPENROUTER_API_KEY = 'test-key';
const { app, assertPublicUrl, isPrivateAddress, normalizeRouteraPrice } = await import('./index.js');

test('posting URL guard blocks private, reserved, and mapped IPv6 addresses', async () => {
  for (const address of ['127.0.0.1', '10.0.0.4', '192.168.1.20', '100.64.0.1', '::1', '::ffff:7f00:1', 'fc00::1', 'ff02::1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1/internal'), /private network/);
  await assert.rejects(() => assertPublicUrl('http://[::1]/internal'), /private network/);
});

test('Routera catalog prices are normalized from per-million units', () => {
  assert.ok(Math.abs(normalizeRouteraPrice('0.2') - 0.0000002) < Number.EPSILON);
  assert.ok(Math.abs(normalizeRouteraPrice('1.2') - 0.0000012) < Number.EPSILON);
  assert.equal(normalizeRouteraPrice('invalid'), 0);
});

test('search lead parser deduplicates canonical posting URLs', () => {
  const leads = extractJobLeads('### [Engineer — Acme](https://example.com/jobs/1#apply)\n- Checked: 2026-09-16\n\n### [Engineer — Acme](https://example.com/jobs/1)\n- Checked: 2026-09-16');
  assert.equal(leads.length, 1);
  assert.equal(leads[0].canonicalUrl, 'https://example.com/jobs/1');
});

test('search lead parser accepts structured headings with a URL field', () => {
  const leads = extractJobLeads('### Engineer — Acme\n- URL: https://example.com/jobs/2\n- Status: Active\n- Evidence: Build reliable systems');
  assert.equal(leads.length, 1);
  assert.equal(leads[0].title, 'Engineer');
  assert.equal(leads[0].company, 'Acme');
  assert.equal(leads[0].canonicalUrl, 'https://example.com/jobs/2');
});

test('search result parsing falls back to structured report content when server jobs are empty', () => {
  const content = '### [Engineer — Acme](https://example.com/jobs/1)\n- Checked: 2026-09-16\n- Status: Active\n- Evidence: Build reliable systems';
  const leads = jobsFromSearchResult({ jobs: [], content });
  assert.equal(leads.length, 1);
  assert.equal(leads[0].canonicalUrl, 'https://example.com/jobs/1');
});

test('run-command returns structured jobs and source results with mocked provider', async () => {
  const originalFetch = globalThis.fetch;
  const role = '### [Engineer — Acme](http://127.0.0.1/jobs/1)\n- Checked: 2026-09-16\n- Status: Active\n- Evidence: Build reliable systems';
  globalThis.fetch = async () => new Response(JSON.stringify({ model: 'test/model', choices: [{ message: { content: role } }], usage: { total_tokens: 7 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const listener = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  try {
    const address = listener.address();
    const register = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: address.port, path: '/api/auth/register', method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => { let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, cookie: response.headers['set-cookie']?.[0], body: JSON.parse(body) })); });
      request.on('error', reject);
      request.end(JSON.stringify({ email: `test-${Date.now()}@example.com`, password: 'test-password-123' }));
    });
    assert.equal(register.status, 201, JSON.stringify(register.body));
    const result = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: address.port, path: '/api/run-command', method: 'POST', headers: { 'content-type': 'application/json', cookie: register.cookie } }, (response) => { let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) })); });
      request.on('error', reject);
      request.end(JSON.stringify({ command: 'find-me-a-job', input: 'Find engineering roles.' }));
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.jobs[0].verification.status, 'unavailable');
    assert.equal(result.body.jobs[0].verificationStatus, 'unverified');
    assert.ok(Array.isArray(result.body.sourceResults));
    assert.ok(result.body.usage.total_tokens > 7, 'usage includes source-agent calls');
  } finally {
    await new Promise((resolve) => listener.close(resolve));
    globalThis.fetch = originalFetch;
  }
});

test('run-command accepts prepare-cv and loads its dedicated prompt', async () => {
  const originalFetch = globalThis.fetch;
  let providerRequest;
  globalThis.fetch = async (_url, options) => {
    providerRequest = JSON.parse(options.body);
    return new Response(JSON.stringify({ model: 'test/model', choices: [{ message: { content: '# Tailored CV\n\n## Profile\nEvidence-based draft' } }], usage: { total_tokens: 9 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const listener = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  try {
    const address = listener.address();
    const register = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: address.port, path: '/api/auth/register', method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => { let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, cookie: response.headers['set-cookie']?.[0], body: JSON.parse(body) })); });
      request.on('error', reject);
      request.end(JSON.stringify({ email: `prepare-cv-${Date.now()}@example.com`, password: 'test-password-123' }));
    });
    assert.equal(register.status, 201, JSON.stringify(register.body));
    const result = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: address.port, path: '/api/run-command', method: 'POST', headers: { 'content-type': 'application/json', cookie: register.cookie } }, (response) => { let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) })); });
      request.on('error', reject);
      request.end(JSON.stringify({ command: 'prepare-cv', cvFormat: 'europass', input: 'ORIGINAL CV CONTENT\nJordan Example\nPlatform leadership\n\nVACANCY FOR THIS ROLE\nHead of Engineering at Acme\n\nSAVED ROLE ANALYSIS\nStrong match.' }));
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.cvFormat, 'europass');
    assert.match(result.body.content, /Tailored CV/);
    assert.match(providerRequest.messages[0].content, /senior recruitment consultant/i);
    assert.match(providerRequest.messages[0].content, /never fabricate/i);
    assert.match(providerRequest.messages[0].content, /Europass-style structured CV/i);
    assert.match(providerRequest.messages[0].content, /not an official Europass export/i);
    assert.match(providerRequest.messages[1].content, /ORIGINAL CV CONTENT/);
    assert.match(providerRequest.messages[1].content, /REQUESTED CV FORMAT.*Europass-style/i);
    const defaultResult = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: address.port, path: '/api/run-command', method: 'POST', headers: { 'content-type': 'application/json', cookie: register.cookie } }, (response) => { let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) })); });
      request.on('error', reject);
      request.end(JSON.stringify({ command: 'prepare-cv', input: 'ORIGINAL CV CONTENT\nVACANCY' }));
    });
    assert.equal(defaultResult.status, 200, JSON.stringify(defaultResult.body));
    assert.equal(defaultResult.body.cvFormat, 'chronological');
    const invalidResult = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: address.port, path: '/api/run-command', method: 'POST', headers: { 'content-type': 'application/json', cookie: register.cookie } }, (response) => { let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) })); });
      request.on('error', reject);
      request.end(JSON.stringify({ command: 'prepare-cv', cvFormat: 'not-a-format', input: 'ORIGINAL CV CONTENT\nVACANCY' }));
    });
    assert.equal(invalidResult.status, 400);
    assert.match(invalidResult.body.error.message, /supported CV format/i);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
    globalThis.fetch = originalFetch;
  }
});
