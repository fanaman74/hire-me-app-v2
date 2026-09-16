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
