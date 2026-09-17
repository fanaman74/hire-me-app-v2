export const SEARCH_SOURCES = [
  { id: 'hn_hiring', label: "HN Who's Hiring", description: 'Monthly Hacker News hiring thread', domains: ['hnhiring.com', 'news.ycombinator.com'] },
  { id: 'weworkremotely', label: 'We Work Remotely', description: 'Remote-first job board', domains: ['weworkremotely.com'] },
  { id: 'remoteok', label: 'RemoteOK', description: 'Remote technology roles', domains: ['remoteok.com'] },
  { id: 'arc_dev', label: 'Arc.dev', description: 'Remote developer roles', domains: ['arc.dev'] },
  { id: 'builtin', label: 'Built In', description: 'Technology company job listings', domains: ['builtin.com'] },
  { id: 'greenhouse', label: 'Greenhouse', description: 'Direct employer listings', domains: ['greenhouse.io', 'boards.greenhouse.io'] },
  { id: 'lever', label: 'Lever', description: 'Direct employer listings', domains: ['jobs.lever.co'] },
  { id: 'linkedin', label: 'LinkedIn', description: 'Public job listings indexed on the web', domains: ['linkedin.com'] },
  { id: 'wellfound', label: 'Wellfound', description: 'Startup and growth-company roles', domains: ['wellfound.com'] },
  { id: 'company_direct', label: 'Company career pages', description: 'Jobs published directly by employers', domains: [] },
];

export const DEFAULT_SEARCH_SOURCES = ['hn_hiring', 'weworkremotely', 'greenhouse', 'lever'];
export const SEARCH_SOURCE_IDS = new Set(SEARCH_SOURCES.map((source) => source.id));

export function customSearchSourceId(url) {
  const normalized = String(url || '').trim();
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = Math.imul(hash ^ normalized.charCodeAt(index), 16777619);
  }
  const slug = normalized
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
    .slice(0, 48) || 'source';
  return `custom_${slug}_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
