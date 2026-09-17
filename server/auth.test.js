import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.NODE_ENV = 'test';
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
process.env.ADMIN_EMAILS = 'first@example.com';
process.env.HMA_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'hire-me-agents-auth-'));
const { app } = await import('./index.js');

async function jsonRequest(baseUrl, requestPath, options = {}) {
  const response = await fetch(`${baseUrl}${requestPath}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  return { response, body: await response.json().catch(() => ({})) };
}

test('local accounts receive isolated sessions and scoped data', async () => {
  const listener = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const baseUrl = `http://127.0.0.1:${listener.address().port}`;
  try {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    const anonymous = await jsonRequest(baseUrl, '/api/profiles');
    assert.equal(anonymous.response.status, 401);

    const first = await jsonRequest(baseUrl, '/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'first@example.com', password: 'first-password' }) });
    assert.equal(first.response.status, 201);
    assert.equal(first.body.user.role, 'admin');
    assert.equal(first.body.user.isAdmin, true);
    const firstCookie = first.response.headers.get('set-cookie').split(';')[0];
    const me = await jsonRequest(baseUrl, '/api/auth/me', { headers: { cookie: firstCookie } });
    assert.equal(me.response.status, 200);
    assert.equal(me.body.user.email, 'first@example.com');
    assert.equal(me.body.user.passwordHash, undefined);

    const saveProfile = await jsonRequest(baseUrl, '/api/profiles', { method: 'PUT', headers: { cookie: firstCookie }, body: JSON.stringify({ candidates: [{ id: 'first-profile', name: 'First', resumeText: 'private CV' }], activeCandidateId: 'first-profile' }) });
    assert.equal(saveProfile.response.status, 200);
    const saveSettings = await jsonRequest(baseUrl, '/api/settings', { method: 'PUT', headers: { cookie: firstCookie }, body: JSON.stringify({ model: 'openai/gpt-4.1-mini', temperature: 0.3, maxTokens: 4096, searchSources: ['remoteok'], apiKey: 'first-secret' }) });
    assert.equal(saveSettings.response.status, 200);
    assert.equal(saveSettings.body.apiKey, undefined);

    const second = await jsonRequest(baseUrl, '/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'second@example.com', password: 'second-password' }) });
    assert.equal(second.response.status, 201);
    assert.equal(second.body.user.role, 'user');
    const secondCookie = second.response.headers.get('set-cookie').split(';')[0];
    const secondProfiles = await jsonRequest(baseUrl, '/api/profiles', { headers: { cookie: secondCookie } });
    assert.deepEqual(secondProfiles.body, { candidates: [], activeCandidateId: '' });
    const secondSettings = await jsonRequest(baseUrl, '/api/settings', { headers: { cookie: secondCookie } });
    assert.equal(secondSettings.body.apiKeyConfigured, false);

    const logout = await jsonRequest(baseUrl, '/api/auth/logout', { method: 'POST', headers: { cookie: firstCookie } });
    assert.equal(logout.response.status, 200);
    const afterLogout = await jsonRequest(baseUrl, '/api/profiles', { headers: { cookie: firstCookie } });
    assert.equal(afterLogout.response.status, 401);
    const google = await fetch(`${baseUrl}/api/auth/google/start`);
    assert.equal(google.status, 503);

    const authData = JSON.parse(await fs.readFile(path.join(process.env.HMA_DATA_DIR, 'auth.json'), 'utf8'));
    assert.ok(authData.users.every((user) => !user.password || !user.password.includes('password')));
    assert.ok(authData.users.every((user) => user.passwordHash && user.passwordSalt));
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
});
