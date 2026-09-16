import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJobUrl, extractJobLeads } from './jobs.js';

test('canonicalJobUrl preserves meaningful queries and removes tracking noise', () => {
  assert.equal(canonicalJobUrl('HTTPS://Example.COM/jobs/42/?utm_source=mail&team=platform#apply'), 'https://example.com/jobs/42?team=platform');
  assert.equal(canonicalJobUrl('https://example.com/#/jobs/42'), 'https://example.com/#/jobs/42');
  assert.notEqual(canonicalJobUrl('https://example.com/jobs/42?team=platform'), canonicalJobUrl('https://example.com/jobs/42?team=sales'));
});

test('extractJobLeads accepts only structured role headings', () => {
  const report = `Here is a link: https://example.com/noise\n\n### [Platform Lead — Acme](https://example.com/jobs/42?utm_campaign=x)\n- Posted: 2026-09-16\n- Closing: Not stated\n- Checked: 2026-09-16\n- Status: Active\n- Location: Remote\n- Work mode: Remote\n- Evidence: Own platform delivery.\n\n### [Platform Lead — Acme](https://example.com/jobs/42#apply)`;
  const [job] = extractJobLeads(report);
  assert.equal(extractJobLeads('The model says [Platform Lead](https://example.com/jobs/99)').length, 0);
  assert.equal(extractJobLeads('```json\n[{"url":"https://example.com/jobs/100"}]\n```').length, 0);
  assert.equal(job.title, 'Platform Lead');
  assert.equal(job.company, 'Acme');
  assert.equal(job.url, 'https://example.com/jobs/42?utm_campaign=x');
  assert.equal(job.canonicalUrl, 'https://example.com/jobs/42');
  assert.equal(job.verificationStatus, 'unverified');
});
