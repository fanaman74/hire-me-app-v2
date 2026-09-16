import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { extractJobLeads } from '../shared/jobs.js';

process.env.NODE_ENV = 'test';
process.env.OPENROUTER_API_KEY = 'test-key';
const { app, assertPublicUrl, isPrivateAddress } = await import('./index.js');

test('posting URL guard blocks private, reserved, and mapped IPv6 addresses', async () => {
  for (const address of ['127.0.0.1', '10.0.0.4', '192.168.1.20', '100.64.0.1', '::1', '::ffff:7f00:1', 'fc00::1', 'ff02::1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1/internal'), /private network/);
  await assert.rejects(() => assertPublicUrl('http://[::1]/internal'), /private network/);
});

test('search lead parser deduplicates canonical posting URLs', () => {
  const leads = extractJobLeads('### [Engineer — Acme](https://example.com/jobs/1#apply)\n- Checked: 2026-09-16\n\n### [Engineer — Acme](https://example.com/jobs/1)\n- Checked: 2026-09-16');
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
    const result = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: address.port, path: '/api/run-command', method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => { let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) })); });
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
