import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import mammoth from 'mammoth';
import { createCvExport, MAX_CV_EXPORT_CHARS } from './cv-export.js';

process.env.NODE_ENV = 'test';
process.env.HMA_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'hire-me-agents-cv-export-'));
const { app } = await import('./index.js');

function request(port, body, cookie = '') {
  return new Promise((resolve, reject) => {
    const requestOptions = { hostname: '127.0.0.1', port, path: '/api/cv-export', method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } };
    const request = http.request(requestOptions, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

test('cv exporter creates Unicode-safe PDF and editable DOCX structures', async () => {
  const content = '# José €uro\n\n## Experience\n\nLed **teams** across [Acme](https://example.com).\n\n- Built a résumé with naïve metrics\n1. First step';
  const pdf = await createCvExport({ content, format: 'pdf', profileName: 'Zoë Ångström', roleTitle: 'Head / Engineering', cvFormat: 'europass' });
  const docx = await createCvExport({ content, format: 'docx', profileName: 'Zoë Ångström', roleTitle: 'Head / Engineering', cvFormat: 'europass' });
  assert.equal(pdf.buffer.subarray(0, 5).toString(), '%PDF-');
  assert.equal(docx.buffer.subarray(0, 4).toString('hex'), '504b0304');
  assert.ok(pdf.buffer.includes(Buffer.from('/FontFile2')), 'PDF embeds the portable Unicode font');
  assert.ok(pdf.buffer.includes(Buffer.from('Ubuntu-Bold')), 'PDF includes a bold font face');
  assert.ok(pdf.buffer.includes(Buffer.from('/ToUnicode')), 'PDF includes a Unicode map');
  assert.ok(docx.buffer.includes(Buffer.from('word/document.xml')), 'DOCX includes the editable document part');
  const extractedDocx = await mammoth.extractRawText({ buffer: docx.buffer });
  assert.match(extractedDocx.value, /José €uro/);
  assert.match(extractedDocx.value, /Led teams across/);
  assert.match(pdf.filename, /^Zoe-Angstrom-Head-Engineering\.pdf$/);
  assert.match(docx.filename, /^Zoe-Angstrom-Head-Engineering\.docx$/);
  assert.ok(pdf.buffer.length > 5000);
  assert.ok(docx.buffer.length > 5000);
});

test('cv export endpoint requires auth and rejects invalid or oversized requests', async () => {
  const listener = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  try {
    const address = listener.address();
    const unauthenticated = await request(address.port, { content: '# CV', format: 'pdf' });
    assert.equal(unauthenticated.status, 401);
    const register = await new Promise((resolve, reject) => {
      const registerRequest = http.request({ hostname: '127.0.0.1', port: address.port, path: '/api/auth/register', method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => { let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, cookie: response.headers['set-cookie']?.[0], body: JSON.parse(body) })); });
      registerRequest.on('error', reject);
      registerRequest.end(JSON.stringify({ email: `cv-export-${Date.now()}@example.com`, password: 'test-password-123' }));
    });
    assert.equal(register.status, 201, JSON.stringify(register.body));
    const invalidFormat = await request(address.port, { content: '# CV', format: 'html' }, register.cookie);
    assert.equal(invalidFormat.status, 400);
    const empty = await request(address.port, { content: '  ', format: 'pdf' }, register.cookie);
    assert.equal(empty.status, 400);
    const oversized = await request(address.port, { content: 'x'.repeat(MAX_CV_EXPORT_CHARS + 1), format: 'pdf' }, register.cookie);
    assert.equal(oversized.status, 413);
    const invalidCvFormat = await request(address.port, { content: '# CV', format: 'pdf', cvFormat: 'invalid-format' }, register.cookie);
    assert.equal(invalidCvFormat.status, 400);
    const pdf = await request(address.port, { content: '# Unicode CV\n\n€ résumé', format: 'pdf', cvFormat: 'combination', profileName: 'Candidate', roleTitle: 'Engineer' }, register.cookie);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.match(pdf.headers['content-disposition'], /Candidate-Engineer\.pdf/);
    assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
    const docx = await request(address.port, { content: '# Unicode CV\n\n€ résumé', format: 'docx', cvFormat: 'combination' }, register.cookie);
    assert.equal(docx.status, 200);
    assert.equal(docx.headers['content-type'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(docx.body.subarray(0, 4).toString('hex'), '504b0304');
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
});
