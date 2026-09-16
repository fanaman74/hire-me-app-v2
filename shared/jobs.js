const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', 'campaignid',
  'tracking', 'trk', 'trk_id',
]);

function isTrackingParam(name) {
  const lower = String(name || '').toLowerCase();
  return TRACKING_PARAMS.has(lower) || lower.startsWith('utm_') || lower.startsWith('ga_');
}

/** Return a stable identity URL while preserving meaningful query parameters. */
export function canonicalJobUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || !url.hostname) return raw;
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if (/^#(?:apply|apply-now|utm[_-].*|trk[_-].*)$/i.test(url.hash)) url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (isTrackingParam(key)) url.searchParams.delete(key);
    }
    const pairs = [...url.searchParams.entries()].sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
    url.search = '';
    pairs.forEach(([key, val]) => url.searchParams.append(key, val));
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
}

function field(block, name) {
  return block.match(new RegExp(`^\\s*-\\s*(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:\\s*(.+)$`, 'im'))?.[1]?.trim() || '';
}

/**
 * Extract only the role records emitted by the structured search-report format.
 * Free-form links, JSON, and model prose are deliberately ignored.
 */
export function extractJobLeads(content) {
  const text = String(content || '').replace(/\r\n/g, '\n');
  const headingPattern = /^###\s+\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\s*$/gim;
  const headings = [...text.matchAll(headingPattern)];
  const jobs = [];
  const seen = new Set();
  headings.forEach((match, index) => {
    const url = canonicalJobUrl(match[2]);
    if (!url || seen.has(url)) return;
    const titleAndCompany = match[1].trim();
    const [title, company = ''] = titleAndCompany.split(/\s+[—–-]\s+/, 2);
    const block = text.slice(match.index + match[0].length, headings[index + 1]?.index || text.length);
    const job = {
      id: `job-${encodeURIComponent(url)}`,
      title: title.trim() || 'Job listing',
      company: company.trim(),
      url: match[2].trim(),
      canonicalUrl: url,
      summary: field(block, 'Evidence'),
      postedDate: field(block, 'Posted'),
      closingDate: field(block, 'Closing'),
      checkedDate: field(block, 'Checked'),
      status: field(block, 'Status'),
      location: field(block, 'Location'),
      workMode: field(block, 'Work mode'),
      compensation: field(block, 'Compensation'),
      source: field(block, 'Source'),
      evidence: field(block, 'Evidence'),
      verificationStatus: 'unverified',
      stage: 'new',
      artifacts: {},
    };
    seen.add(url);
    jobs.push(job);
  });
  return jobs.slice(0, 100);
}

export function recoverJobRecords(savedJobs, dismissedJobIds = []) {
  const dismissed = new Set(Array.isArray(dismissedJobIds) ? dismissedJobIds : []);
  return (Array.isArray(savedJobs) ? savedJobs : []).filter((job) => {
    const url = canonicalJobUrl(job?.url);
    return job?.id && url && !dismissed.has(job.id) && !dismissed.has(url);
  }).map((job) => ({
    ...job,
    url: String(job.url).trim(),
    stage: job.stage || 'new',
    verificationStatus: job.verification?.status || job.verificationStatus || 'previously-checked',
  }));
}

export function mergeJobRecords(existingJobs, incomingJobs, dismissedJobIds = []) {
  const dismissed = new Set(Array.isArray(dismissedJobIds) ? dismissedJobIds : []);
  const usable = (job) => {
    const url = canonicalJobUrl(job?.url);
    return job?.id && url && !dismissed.has(job.id) && !dismissed.has(url);
  };
  const byUrl = new Map((Array.isArray(existingJobs) ? existingJobs : []).filter(usable).map((job) => [canonicalJobUrl(job.url), job]));
  (Array.isArray(incomingJobs) ? incomingJobs : []).filter(usable).forEach((job) => {
    const key = canonicalJobUrl(job.url);
    const previous = byUrl.get(key);
    byUrl.set(key, {
      ...(previous || {}),
      ...job,
      id: previous?.id || job.id,
      stage: previous?.stage || job.stage || 'new',
      artifacts: { ...(previous?.artifacts || {}), ...(job.artifacts || {}) },
      summary: job.summary || previous?.summary || '',
      firstSeenAt: previous?.firstSeenAt || job.lastSeenAt || new Date().toISOString(),
    });
  });
  return [...byUrl.values()];
}
