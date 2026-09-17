import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_SEARCH_SOURCES, SEARCH_SOURCES } from '../shared/search-sources.js';
import { canonicalJobUrl, extractJobLeads } from '../shared/jobs.js';
import { nextWorkflowFor } from '../shared/workflow-navigation.js';
import {
  Activity,
  ArrowRight,
  Bot,
  BriefcaseBusiness,
  Check,
  CircleCheckBig,
  ChevronDown,
  CircleHelp,
  Clock3,
  Command,
  Copy,
  FileText,
  FileCheck,
  Gauge,
  Globe2,
  KeyRound,
  LayoutDashboard,
  Link2,
  LogOut,
  LockKeyhole,
  Mail,
  Menu,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Target,
  UploadCloud,
  Users,
  X,
  Zap,
} from 'lucide-react';

const NAV = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'workflows', label: 'Agent workflows', icon: Command },
  { id: 'candidates', label: 'Profiles', icon: Users },
  { id: 'pipeline', label: 'Pipeline', icon: BriefcaseBusiness },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const WORKFLOWS = [
  { id: 'setup-candidate', number: '01', title: 'Setup profile', description: 'Turn a resume file into a structured job-search profile.', icon: Users, placeholder: 'Paste the profile resume text…' },
  { id: 'build-search-config', number: '02', title: 'Build search config', description: 'Infer roles, filters, compensation targets, and priorities.', icon: SlidersHorizontal, placeholder: 'Paste a resume or profile to generate a search configuration…' },
  { id: 'find-me-a-job', number: '03', title: 'Find matching jobs', description: 'Search from the saved profile and search configuration using default and custom sources.', icon: Search, placeholder: 'Optional: add instructions for this search run…' },
  { id: 'add-job', number: '04', title: 'Analyze a job', description: 'Score one job and build a focused application package.', icon: Plus, placeholder: 'Paste the full job listing and profile context…' },
  { id: 'write-cover-letter', number: '05', title: 'Write cover letter', description: 'Produce a direct, specific letter grounded in the resume.', icon: FileText, placeholder: 'Paste the job description and the relevant resume…' },
  { id: 'interview-prep', number: '06', title: 'Interview prep', description: 'Predict questions, prepare STAR stories, and plan negotiation.', icon: Target, placeholder: 'Paste the job description, resume, and known interview format…' },
  { id: 'mark-submitted', number: '07', title: 'Track submission', description: 'Prepare a clean application status update.', icon: Check, placeholder: 'Enter the role, company, current status, and note…' },
  { id: 'job-stats', number: '08', title: 'Pipeline stats', description: 'Summarize application activity and conversion health.', icon: Gauge, placeholder: 'Paste your application ledger JSON…' },
  { id: 'export-resume', number: '09', title: 'Export resume', description: 'Prepare resume content for document export.', icon: FileText, placeholder: 'Paste the tailored resume Markdown…' },
];

const DEFAULT_MODEL = 'openai/gpt-4.1-mini';

function loadCandidates(scope = '') {
  const suffix = scope ? `:${scope}` : '';
  try {
    const scoped = localStorage.getItem(`hma-candidates${suffix}`);
    const legacy = scope ? localStorage.getItem('hma-candidates') : null;
    const parsed = JSON.parse(scoped || legacy || '[]');
    return Array.isArray(parsed) ? parsed.map((candidate) => {
      const savedJobs = Array.isArray(candidate.jobs) ? candidate.jobs : [];
      const recoveredJobs = recoverJobs(savedJobs, candidate.dismissedJobIds);
      return { ...candidate, workflowOutputs: candidate.workflowOutputs || {}, jobs: recoveredJobs };
    }) : [];
  } catch {
    return [];
  }
}

function prepareCandidates(candidates) {
  return candidates.map((candidate) => {
    const savedJobs = Array.isArray(candidate.jobs) ? candidate.jobs : [];
    const recoveredJobs = recoverJobs(savedJobs, candidate.dismissedJobIds);
    return { ...candidate, workflowOutputs: candidate.workflowOutputs || {}, jobs: recoveredJobs };
  });
}

function recoverJobs(savedJobs, dismissedJobIds = []) {
  const dismissed = new Set(Array.isArray(dismissedJobIds) ? dismissedJobIds : []);
  return savedJobs
    .filter((job) => {
      const url = canonicalJobUrl(job?.url);
      return job?.id && url && !dismissed.has(job.id) && !dismissed.has(url);
    })
    .map((job) => ({
      ...job,
      url: canonicalJobUrl(job.url),
      stage: job.stage || 'new',
      verificationStatus: job.verification?.status || job.verificationStatus || 'previously-checked',
    }));
}

function mergeJobs(existingJobs, incomingJobs, dismissedJobIds = []) {
  const dismissed = new Set(Array.isArray(dismissedJobIds) ? dismissedJobIds : []);
  const usable = (job) => {
    const url = canonicalJobUrl(job?.url);
    return job && job.id && url && !dismissed.has(job.id) && !dismissed.has(url);
  };
  const byUrl = new Map(existingJobs.filter(usable).map((job) => [canonicalJobUrl(job.url), {
    ...job,
    url: canonicalJobUrl(job.url),
    stage: job.stage || 'new',
    verificationStatus: job.verification?.status || job.verificationStatus || 'previously-checked',
  }]));
  incomingJobs.filter(usable).forEach((job) => {
    const key = canonicalJobUrl(job.url);
    const previous = byUrl.get(key);
    byUrl.set(key, {
      ...job,
      url: key,
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

function mergeCandidates(localCandidates, storedCandidates) {
  const merged = new Map(storedCandidates.map((candidate) => [candidate.id, candidate]));
  localCandidates.forEach((candidate) => {
    const stored = merged.get(candidate.id);
    const localTimestamp = candidate.updatedAt || candidate.createdAt || '';
    const storedTimestamp = stored?.updatedAt || stored?.createdAt || '';
    if (!stored || localTimestamp > storedTimestamp) merged.set(candidate.id, candidate);
  });
  return prepareCandidates([...merged.values()]);
}

function mergeBackupCandidates(currentCandidates, backup) {
  if (!backup || typeof backup !== 'object' || !Array.isArray(backup.candidates) || !backup.candidates.length) {
    throw new Error('Choose a profile backup JSON file containing at least one profile.');
  }
  if (backup.candidates.length > 100) throw new Error('A backup can contain at most 100 profiles.');
  const imported = backup.candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') throw new Error(`Backup profile ${index + 1} is invalid.`);
    const name = String(candidate.name || '').trim();
    const targetRoles = Array.isArray(candidate.targetRoles)
      ? candidate.targetRoles.map((role) => String(role).trim()).filter(Boolean)
      : String(candidate.targetRoles || '').split(',').map((role) => role.trim()).filter(Boolean);
    const resumeText = String(candidate.resumeText || '').trim();
    if (!name || !targetRoles.length || !resumeText) throw new Error(`Backup profile ${index + 1} needs a name, target role, and CV.`);
    if (candidate.jobs != null && !Array.isArray(candidate.jobs)) throw new Error(`Backup profile ${index + 1} has an invalid jobs list.`);
    if (candidate.customSearchSites != null && (!Array.isArray(candidate.customSearchSites) || candidate.customSearchSites.length > 20 || candidate.customSearchSites.some((site) => !/^https?:\/\/[^\s]+$/i.test(String(site))))) {
      throw new Error(`Backup profile ${index + 1} has invalid custom search sites.`);
    }
    if (candidate.workflowOutputs != null && (typeof candidate.workflowOutputs !== 'object' || Array.isArray(candidate.workflowOutputs))) throw new Error(`Backup profile ${index + 1} has invalid workflow outputs.`);
    return {
      ...candidate,
      id: String(candidate.id || `candidate-import-${Date.now()}-${index}`),
      name,
      targetRoles,
      resumeText,
      completedSteps: Array.isArray(candidate.completedSteps) ? candidate.completedSteps : [],
      workflowOutputs: candidate.workflowOutputs && typeof candidate.workflowOutputs === 'object' ? candidate.workflowOutputs : {},
      jobs: Array.isArray(candidate.jobs) ? candidate.jobs : [],
      dismissedJobIds: Array.isArray(candidate.dismissedJobIds) ? candidate.dismissedJobIds : [],
    };
  });
  const byId = new Map(currentCandidates.map((candidate) => [candidate.id, candidate]));
  imported.forEach((candidate) => {
    const existing = byId.get(candidate.id);
    if (!existing) {
      byId.set(candidate.id, { ...candidate, createdAt: candidate.createdAt || new Date().toISOString() });
      return;
    }
    const dismissedJobIds = [...new Set([...(existing.dismissedJobIds || []), ...(candidate.dismissedJobIds || [])])];
    byId.set(candidate.id, {
      ...candidate,
      ...existing,
      dismissedJobIds,
      workflowOutputs: { ...(candidate.workflowOutputs || {}), ...(existing.workflowOutputs || {}) },
      jobs: mergeJobs(existing.jobs || [], candidate.jobs || [], dismissedJobIds),
      updatedAt: existing.updatedAt || candidate.updatedAt || new Date().toISOString(),
    });
  });
  return prepareCandidates([...byId.values()]);
}

function cacheProfiles(candidates, activeCandidateId, scope = '') {
  const suffix = scope ? `:${scope}` : '';
  try {
    localStorage.setItem(`hma-candidates${suffix}`, JSON.stringify(candidates));
    localStorage.setItem(`hma-candidate-count${suffix}`, String(candidates.length));
    if (activeCandidateId) localStorage.setItem(`hma-active-candidate${suffix}`, activeCandidateId);
    else localStorage.removeItem(`hma-active-candidate${suffix}`);
  } catch (error) {
    console.warn('Browser profile cache is unavailable; profiles will still be saved to local disk.', error);
  }
}

async function api(path, options) {
  let response;
  try {
    response = await fetch(path, { credentials: 'include', ...(options || {}) });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('The local API server is not reachable. Start it with `npm run dev`, then try again.');
    }
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Request failed (${response.status})`);
  return data;
}

function formatPrice(value) {
  if (!value) return '$0.00';
  return `$${(value * 1_000_000).toFixed(value * 1_000_000 < 1 ? 2 : 1)}`;
}

function formatContext(value) {
  if (!value) return '—';
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : `${Math.round(value / 1000)}K`;
}

function verificationLabel(job) {
  const status = job?.verification?.status || job?.verificationStatus;
  if (status === 'page-fetched') return 'Page fetched';
  if (status === 'unavailable') return 'Unavailable';
  if (status === 'previously-checked') return 'Previously checked';
  return 'Unverified';
}

function extractJobs(content, { requireVerification = false } = {}) {
  const jobs = [];
  const seen = new Set();
  const addJob = (job) => {
    const url = String(job.url || job.link || job.applyUrl || '').trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
    const title = String(job.title || job.role || job.name || 'Job listing').trim();
    const company = String(job.company || job.organization || '').trim();
    const canonicalUrl = canonicalJobUrl(url);
    const stableId = `job-${encodeURIComponent(canonicalUrl)}`;
    if (seen.has(canonicalUrl)) return;
    seen.add(canonicalUrl);
    jobs.push({
      id: stableId,
      title,
      company,
      url: canonicalUrl,
      summary: String(job.summary || job.description || '').trim(),
      postedDate: String(job.postedDate || '').trim(),
      closingDate: String(job.closingDate || '').trim(),
      checkedDate: String(job.checkedDate || '').trim(),
      status: String(job.status || '').trim(),
      location: String(job.location || '').trim(),
      workMode: String(job.workMode || '').trim(),
      compensation: String(job.compensation || '').trim(),
      source: String(job.source || '').trim(),
      evidence: String(job.evidence || '').trim(),
      verificationStatus: String(job.verificationStatus || 'unverified').trim(),
      stage: String(job.stage || 'new').trim().toLowerCase(),
      artifacts: job.artifacts && typeof job.artifacts === 'object' ? job.artifacts : {},
      lastSeenAt: new Date().toISOString(),
    });
  };
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    if (value.url || value.link || value.applyUrl) addJob(value);
    Object.values(value).forEach((nested) => {
      if (nested && typeof nested === 'object') walk(nested);
    });
  };
  const roleHeadingPattern = /^###\s+\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gim;
  const text = String(content || '');
  const roleHeadings = [...text.matchAll(roleHeadingPattern)];
  for (const [index, match] of roleHeadings.entries()) {
    const [title, company = ''] = match[1].split(/\s+[—–-]\s+/, 2);
    const block = text.slice(match.index + match[0].length, roleHeadings[index + 1]?.index || text.length);
    const field = (name) => block.match(new RegExp(`^\\s*-\\s*(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:\\s*(.+)$`, 'im'))?.[1]?.trim() || '';
    const checkedDate = field('Checked');
    const status = field('Status');
    const verifiedToday = checkedDate === new Date().toISOString().slice(0, 10) && /^active\b/i.test(status);
    if (!requireVerification || (verifiedToday && /^active\b/i.test(status) && field('Evidence'))) addJob({
      title,
      company,
      url: match[2],
      postedDate: field('Posted'),
      closingDate: field('Closing'),
      checkedDate,
      status,
      location: field('Location'),
      workMode: field('Work mode'),
      compensation: field('Compensation'),
      source: field('Source'),
      evidence: field('Evidence'),
      verificationStatus: 'unverified',
    });
  }
  if (roleHeadings.length || requireVerification) return jobs.slice(0, 100);

  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  blocks.forEach((match) => {
    try { walk(JSON.parse(match[1])); } catch { /* Markdown output is handled below. */ }
  });

  const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi;
  for (const match of String(content || '').matchAll(markdownLinkPattern)) addJob({ title: match[1], url: match[2] });
  const bareUrlPattern = /https?:\/\/[^\s)<>]+/gi;
  for (const match of String(content || '').matchAll(bareUrlPattern)) addJob({ url: match[0] });
  return jobs.slice(0, 100);
}

function lastWorkflowFor(profile) {
  return WORKFLOWS.find((workflow) => workflow.id === profile?.lastWorkflowId)
    || [...WORKFLOWS].reverse().find((workflow) => profile?.workflowOutputs?.[workflow.id])
    || WORKFLOWS[0];
}

function workflowOutputText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function WorkspaceApp({ user, onLogout, notice = '' }) {
  const [page, setPage] = useState('overview');
  const [mobileNav, setMobileNav] = useState(false);
  const [settings, setSettings] = useState({ model: DEFAULT_MODEL, temperature: 0.3, maxTokens: 4096, searchSources: DEFAULT_SEARCH_SOURCES, apiKeyConfigured: false });
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [profileStorageError, setProfileStorageError] = useState('');
  const storageScope = user.id;
  const [candidates, setCandidates] = useState(() => loadCandidates(storageScope));
  const [activeCandidateId, setActiveCandidateId] = useState(() => localStorage.getItem(`hma-active-candidate:${storageScope}`) || '');
  const candidatesRef = useRef(candidates);
  const activeCandidateIdRef = useRef(activeCandidateId);
  const profileSaveQueue = useRef(Promise.resolve());
  const [profileSaveStatus, setProfileSaveStatus] = useState('loading');

  useEffect(() => { candidatesRef.current = candidates; }, [candidates]);
  useEffect(() => { activeCandidateIdRef.current = activeCandidateId; }, [activeCandidateId]);

  useEffect(() => {
    api('/api/settings')
      .then(setSettings)
      .catch(() => {})
      .finally(() => setSettingsLoading(false));
  }, []);

  useEffect(() => {
    const localCandidates = loadCandidates(storageScope);
    const scopedCacheKey = `hma-candidates:${storageScope}`;
    const migratingLegacyCache = Boolean(storageScope && !localStorage.getItem(scopedCacheKey) && localStorage.getItem('hma-candidates'));
    const localActiveCandidateId = localStorage.getItem(`hma-active-candidate:${storageScope}`)
      || (migratingLegacyCache ? localStorage.getItem('hma-active-candidate') : '')
      || '';
    api('/api/profiles')
      .then((stored) => {
        const restored = mergeCandidates(localCandidates, stored.candidates || []);
        const restoredActiveId = stored.activeCandidateId || localActiveCandidateId || restored[0]?.id || '';
        setCandidates(restored);
        candidatesRef.current = restored;
        setActiveCandidateId(restoredActiveId);
        activeCandidateIdRef.current = restoredActiveId;
        setProfileSaveStatus('saved');
        cacheProfiles(restored, restoredActiveId, storageScope);
        if (migratingLegacyCache) {
          localStorage.removeItem('hma-candidates');
          localStorage.removeItem('hma-candidate-count');
          localStorage.removeItem('hma-active-candidate');
        }
        if (restored.length && (JSON.stringify(restored) !== JSON.stringify(stored.candidates || []) || restoredActiveId !== stored.activeCandidateId)) {
          return api('/api/profiles', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ candidates: restored, activeCandidateId: restoredActiveId }),
          });
        }
        return null;
      })
      .catch((error) => { setProfileSaveStatus('error'); setProfileStorageError(`Profiles could not be loaded from local disk: ${error.message}`); });
  }, [storageScope]);

  const activeCandidate = candidates.find((candidate) => candidate.id === activeCandidateId) || candidates[0] || null;

  useEffect(() => {
    try {
      if (activeCandidate?.id) localStorage.setItem(`hma-active-candidate:${storageScope}`, activeCandidate.id);
      else localStorage.removeItem(`hma-active-candidate:${storageScope}`);
    } catch { /* The disk-backed profile store remains authoritative. */ }
    if (activeCandidate?.id && activeCandidateId !== activeCandidate.id) setActiveCandidateId(activeCandidate.id);
  }, [activeCandidate?.id, activeCandidateId, storageScope]);

  function persistCandidates(nextOrUpdater, nextActiveCandidateId = activeCandidateIdRef.current) {
    const next = typeof nextOrUpdater === 'function' ? nextOrUpdater(candidatesRef.current) : nextOrUpdater;
    candidatesRef.current = next;
    activeCandidateIdRef.current = nextActiveCandidateId;
    setCandidates(next);
    setActiveCandidateId(nextActiveCandidateId);
    cacheProfiles(next, nextActiveCandidateId, storageScope);
    setProfileStorageError('');
    setProfileSaveStatus('saving');
    profileSaveQueue.current = profileSaveQueue.current.catch(() => {}).then(() => api('/api/profiles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidates: next, activeCandidateId: nextActiveCandidateId }),
    })).then(() => setProfileSaveStatus('saved')).catch((error) => {
      setProfileSaveStatus('error');
      setProfileStorageError(`Profiles could not be saved to local disk: ${error.message}`);
    });
  }

  function addCandidate(candidate) {
    const nextCandidate = {
      ...candidate,
      id: globalThis.crypto?.randomUUID?.() || `candidate-${Date.now()}`,
      completedSteps: [],
      workflowOutputs: {},
      customSearchSites: [],
      createdAt: new Date().toISOString(),
    };
    persistCandidates((current) => [...current, nextCandidate], nextCandidate.id);
    setActiveCandidateId(nextCandidate.id);
    return nextCandidate;
  }

  function selectCandidate(candidateId) {
    setActiveCandidateId(candidateId);
    persistCandidates((current) => current, candidateId);
  }

  function updateCandidate(candidateId, patch) {
    persistCandidates((current) => current.map((candidate) => candidate.id === candidateId
      ? { ...candidate, ...patch, updatedAt: new Date().toISOString() }
      : candidate));
  }

  function completeWorkflow(workflowId, workflowOutput, workflowJobs = [], workflowJobId = '', candidateId = activeCandidateIdRef.current) {
    if (!candidateId) return;
    persistCandidates((current) => current.map((candidate) => candidate.id === candidateId
      ? {
          ...candidate,
          completedSteps: [...new Set([...(candidate.completedSteps || []), workflowId])],
          workflowOutputs: { ...(candidate.workflowOutputs || {}), [workflowId]: workflowOutputText(workflowOutput) },
          lastWorkflowId: workflowId,
          ...(workflowId === 'find-me-a-job' ? { jobs: mergeJobs(candidate.jobs || [], workflowJobs, candidate.dismissedJobIds || []) } : {}),
          ...(workflowJobId && ['add-job', 'write-cover-letter', 'interview-prep'].includes(workflowId) ? {
            jobs: (candidate.jobs || []).map((job) => job.id === workflowJobId
              ? { ...job, artifacts: { ...(job.artifacts || {}), [{ 'add-job': 'analysis', 'write-cover-letter': 'coverLetter', 'interview-prep': 'interviewPrep' }[workflowId]]: workflowOutputText(workflowOutput) } }
              : job),
          } : {}),
          updatedAt: new Date().toISOString(),
        }
      : candidate));
  }

  function updateCandidateSites(candidateId, customSearchSites) {
    persistCandidates((current) => current.map((candidate) => candidate.id === candidateId
      ? { ...candidate, customSearchSites, updatedAt: new Date().toISOString() }
      : candidate));
  }

  function updateCandidateSalary(candidateId, salaryExpectationEur, salaryExpectationBasis = '') {
    persistCandidates((current) => current.map((candidate) => candidate.id === candidateId
      ? { ...candidate, salaryExpectationEur, salaryExpectationBasis, updatedAt: new Date().toISOString() }
      : candidate));
  }

  function removeCandidateJob(candidateId, jobId) {
    persistCandidates((current) => current.map((candidate) => candidate.id === candidateId
      ? { ...candidate, jobs: (candidate.jobs || []).filter((job) => job.id !== jobId), dismissedJobIds: [...new Set([...(candidate.dismissedJobIds || []), jobId, canonicalJobUrl((candidate.jobs || []).find((job) => job.id === jobId)?.url)].filter(Boolean))], updatedAt: new Date().toISOString() }
      : candidate));
  }

  function selectCandidateJob(candidateId, jobId) {
    persistCandidates((current) => current.map((candidate) => candidate.id === candidateId
      ? { ...candidate, lastJobId: jobId, updatedAt: new Date().toISOString() }
      : candidate));
  }

  function updateCandidateJob(candidateId, jobId, summary) {
    persistCandidates((current) => current.map((candidate) => candidate.id === candidateId
      ? { ...candidate, jobs: (candidate.jobs || []).map((job) => job.id === jobId ? { ...job, summary } : job), updatedAt: new Date().toISOString() }
      : candidate));
  }

  function updateCandidateJobStage(candidateId, jobId, stage) {
    persistCandidates((current) => current.map((candidate) => candidate.id === candidateId
      ? { ...candidate, jobs: (candidate.jobs || []).map((job) => job.id === jobId ? { ...job, stage, lastStageChangedAt: new Date().toISOString(), stageHistory: [...(Array.isArray(job.stageHistory) ? job.stageHistory : []), { stage, changedAt: new Date().toISOString() }] } : job), updatedAt: new Date().toISOString() }
      : candidate));
  }

  function restoreBackup(backup) {
    const restored = mergeBackupCandidates(candidatesRef.current, backup);
    const activeId = activeCandidateIdRef.current || restored[0]?.id || '';
    persistCandidates(restored, activeId);
    return restored.length;
  }

  function navigate(next) {
    setPage(next);
    setMobileNav(false);
  }

  const activeLabel = NAV.find((item) => item.id === page)?.label || 'Overview';

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
        <div className="brand-lockup">
          <div className="brand-mark"><Bot size={20} strokeWidth={1.8} /></div>
          <div>
            <div className="brand-name">HIRE ME</div>
            <div className="brand-name brand-accent">AGENTS</div>
          </div>
          <button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={18} /></button>
        </div>

        <nav className="main-nav" aria-label="Main navigation">
          <span className="nav-caption">WORKSPACE</span>
          {NAV.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => navigate(id)}>
              <Icon size={17} strokeWidth={1.7} />
              <span>{label}</span>
              {id === 'pipeline' && <span className="nav-count">{candidates.reduce((count, candidate) => count + (candidate.jobs || []).length, 0)}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-status">
          <div className="status-led" />
          <div>
            <span className="status-title">SIGNED IN</span>
            <span className="status-copy">{user.email}</span>
          </div>
        </div>
        <div className="sidebar-model">
          <span className="nav-caption">ACTIVE MODEL</span>
          <button onClick={() => navigate('settings')}>
            <span className="model-pulse" />
            <span title={settings.model}>{settingsLoading ? 'LOADING…' : settings.model}</span>
            <ArrowRight size={14} />
          </button>
        </div>
        <button type="button" className="button secondary compact auth-signout" onClick={onLogout}><LogOut size={14} /> Sign out</button>
      </aside>

      {mobileNav && <button className="scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation" />}

      <main className="main-panel">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={20} /></button>
          <div className="breadcrumb"><span>HMA</span><span>/</span><strong>{activeLabel}</strong></div>
          <div className="topbar-actions">
            <button className="model-chip" onClick={() => navigate('settings')}>
              <span className="model-pulse" />
              <span>{settings.model}</span>
              <ChevronDown size={14} />
            </button>
            <button className="icon-button" aria-label="Help"><CircleHelp size={18} /></button>
          </div>
        </header>

        <div className="page-stage">
          {notice && <div className="auth-notice workspace-auth-notice">{notice}</div>}
          {profileStorageError && <div className="error-banner"><span>{profileStorageError}</span></div>}
          {page === 'overview' && <Overview onNavigate={navigate} settings={settings} candidates={candidates} activeCandidate={activeCandidate} onSelectCandidate={selectCandidate} />}
          {page === 'workflows' && <WorkflowStudio settings={settings} activeCandidate={activeCandidate} onWorkflowComplete={completeWorkflow} onUpdateCandidateSites={updateCandidateSites} onUpdateCandidateSalary={updateCandidateSalary} onRemoveCandidateJob={removeCandidateJob} onSelectCandidateJob={selectCandidateJob} onUpdateCandidateJob={updateCandidateJob} onUpdateCandidateJobStage={updateCandidateJobStage} onOpenSettings={() => navigate('settings')} onOpenCandidates={() => navigate('candidates')} />}
          {page === 'candidates' && <Candidates candidates={candidates} activeCandidate={activeCandidate} onAddCandidate={addCandidate} onUpdateCandidate={updateCandidate} onSelectCandidate={selectCandidate} onRestoreBackup={restoreBackup} onStart={() => navigate('workflows')} />}
          {page === 'pipeline' && <Pipeline candidates={candidates} onUpdateStage={updateCandidateJobStage} onStart={() => navigate('workflows')} />}
          {page === 'settings' && <SettingsPage settings={settings} setSettings={setSettings} />}
        </div>
        <div className="profile-save-status" aria-live="polite">{profileSaveStatus === 'loading' ? 'Loading profiles…' : profileSaveStatus === 'saving' ? 'Saving profiles…' : profileSaveStatus === 'error' ? 'Profile save failed' : 'Profiles saved locally'}</div>
      </main>
    </div>
  );
}

function AuthScreen({ googleEnabled, initialNotice, onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message || 'Could not sign in.');
      onAuthenticated(data.user);
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-brand"><div className="brand-mark"><Bot size={22} strokeWidth={1.8} /></div><div><div className="brand-name">HIRE ME</div><div className="brand-name brand-accent">AGENTS</div></div></div>
        <span className="eyebrow">PRIVATE WORKSPACE</span>
        <h1>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
        <p className="auth-copy">Sign in to keep your profiles, applications, and agent settings private to your account.</p>
        {initialNotice && <div className="auth-notice">{initialNotice}</div>}
        {googleEnabled ? <button type="button" className="button google-button" onClick={() => { window.location.href = '/api/auth/google/start'; }}><span className="google-g">G</span> Continue with Google</button> : <div className="auth-disabled"><Globe2 size={15} /> Google sign-in is not configured for this deployment.</div>}
        <div className="auth-divider"><span>or use email</span></div>
        <form onSubmit={submit} className="auth-form">
          <label className="field-label" htmlFor="auth-email"><Mail size={13} /> EMAIL</label>
          <input id="auth-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          <label className="field-label" htmlFor="auth-password"><LockKeyhole size={13} /> PASSWORD</label>
          <input id="auth-password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required />
          {mode === 'register' && <small className="auth-help">Use at least 8 characters.</small>}
          {error && <div className="error-banner">{error}</div>}
          <button type="submit" className="button primary auth-submit" disabled={busy}>{busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>
        <button type="button" className="text-button auth-switch" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'login' ? 'Create a local account' : 'I already have an account'}</button>
      </section>
    </main>
  );
}

function App() {
  const [status, setStatus] = useState('loading');
  const [user, setUser] = useState(null);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('auth') === 'success') setNotice('Google sign-in complete.');
    if (params.get('authError')) setNotice(params.get('authError'));
    if (params.has('auth') || params.has('authError')) window.history.replaceState({}, '', window.location.pathname);
    Promise.all([
      fetch('/api/auth/config', { credentials: 'include' }).then((response) => response.json()),
      fetch('/api/auth/me', { credentials: 'include' }).then(async (response) => response.ok ? response.json() : null),
    ]).then(([config, current]) => {
      setGoogleEnabled(Boolean(config.googleEnabled));
      setUser(current?.user || null);
      setStatus('ready');
    }).catch(() => setStatus('ready'));
  }, []);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
    setUser(null);
    setNotice('You have been signed out.');
  }

  if (status === 'loading') return <main className="auth-shell"><div className="auth-loading">Loading your workspace…</div></main>;
  if (!user) return <AuthScreen googleEnabled={googleEnabled} initialNotice={notice} onAuthenticated={(nextUser) => { setNotice(''); setUser(nextUser); }} />;
  return <WorkspaceApp user={user} onLogout={logout} notice={notice} />;
}

function PageIntro({ eyebrow, title, copy, action }) {
  return (
    <section className="page-intro">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{copy}</p>
      </div>
      {action}
    </section>
  );
}

function Overview({ onNavigate, settings, candidates, activeCandidate, onSelectCandidate }) {
  const completedSteps = activeCandidate?.completedSteps || [];
  const jobs = candidates.flatMap((candidate) => candidate.jobs || []);
  const submitted = jobs.filter((job) => ['submitted', 'interviewing', 'offered'].includes(job.stage)).length;
  const responded = jobs.filter((job) => ['interviewing', 'offered'].includes(job.stage)).length;
  return (
    <>
      <PageIntro
        eyebrow="JOB SEARCH CONTROL ROOM"
        title={<>Make the search<br /><span>systematic.</span></>}
        copy="Nine focused agents turn a resume into a search strategy, application package, and measurable pipeline."
        action={<button className="button primary" onClick={() => onNavigate('workflows')}><Play size={16} fill="currentColor" /> Continue workflow</button>}
      />

      <section className="candidate-switcher panel">
        <div className="candidate-switcher-heading"><span className="eyebrow">ACTIVE PROFILE</span><button className="text-button" onClick={() => onNavigate('candidates')}>{candidates.length ? 'Manage profiles' : 'Add profile'} <ArrowRight size={14} /></button></div>
        {candidates.length ? (
          <div className="candidate-tabs">
            {candidates.map((candidate) => {
              const selected = candidate.id === activeCandidate?.id;
              return <button key={candidate.id} className={selected ? 'selected' : ''} onClick={() => onSelectCandidate(candidate.id)}><span className="candidate-initials">{candidate.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</span><span><strong>{candidate.name}</strong><small>{candidate.targetRoles?.join(' · ') || 'No target roles set'}</small></span>{selected && <Check size={16} />}</button>;
            })}
          </div>
        ) : (
          <button className="candidate-empty-switch" onClick={() => onNavigate('candidates')}><Plus size={18} /><span><strong>Add your first profile</strong><small>Upload a CV and define the roles this profile should target.</small></span><ArrowRight size={16} /></button>
        )}
        {activeCandidate && <div className="candidate-progress"><span><strong>{completedSteps.length}</strong> of {WORKFLOWS.length} steps completed for {activeCandidate.name}</span><span className="candidate-progress-track"><i style={{ width: `${(completedSteps.length / WORKFLOWS.length) * 100}%` }} /></span></div>}
      </section>

      <section className="signal-strip">
        <div><Activity size={16} /><span>SYSTEM</span><strong>READY</strong></div>
        <div><Bot size={16} /><span>MODEL</span><strong>{settings.model}</strong></div>
        <div><ShieldCheck size={16} /><span>API KEY</span><strong>{settings.apiKeyConfigured ? 'CONFIGURED' : 'REQUIRED'}</strong></div>
      </section>

      <section className="metric-grid">
        <Metric number={candidates.length} label="Profiles" note="Ready to search" />
        <Metric number={jobs.length} label="Jobs found" note="Across all searches" />
        <Metric number={submitted} label="Submitted" note="Applications tracked" />
        <Metric number={submitted ? `${Math.round((responded / submitted) * 100)}%` : '—'} label="Response rate" note="Interviewing or offered" />
      </section>

      <section className="two-column">
        <div className="panel workflow-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">THE WORKFLOW</span><h2>{activeCandidate ? `${activeCandidate.name} · ${completedSteps.length}/${WORKFLOWS.length} complete` : 'From resume to interview'}</h2></div>
            <button className="text-button" onClick={() => onNavigate('workflows')}>View all agents <ArrowRight size={15} /></button>
          </div>
          <div className="workflow-list">
            {WORKFLOWS.map(({ id, number, title, description, icon: Icon }, index) => {
              const completed = completedSteps.includes(id);
              return (
              <button key={number} className={`workflow-row ${completed ? 'completed' : ''}`} onClick={() => onNavigate('workflows')}>
                <span className="workflow-number">{completed ? <CircleCheckBig size={16} /> : number}</span>
                <span className="workflow-icon"><Icon size={18} /></span>
                <span className="workflow-copy"><strong>{title}</strong><small>{description}</small></span>
                {completed ? <span className="completed-label">COMPLETED</span> : index === 0 && <span className="recommended">START HERE</span>}
                <ArrowRight size={16} className="row-arrow" />
              </button>
            );})}
          </div>
        </div>

        <div className="panel readiness-panel">
          <div className="panel-heading"><div><span className="eyebrow">READINESS</span><h2>Before your first run</h2></div></div>
          <ReadinessItem complete={settings.apiKeyConfigured} number="1" title={settings.apiKeyConfigured ? 'OpenRouter configured' : 'Add your OpenRouter key'} copy={settings.apiKeyConfigured ? 'The selected model is ready to run.' : 'Required to run any agent.'} action={() => onNavigate('settings')} />
          <ReadinessItem complete={Boolean(activeCandidate)} number="2" title={activeCandidate ? `Profile: ${activeCandidate.name}` : 'Create a profile'} copy={activeCandidate ? activeCandidate.targetRoles.join(' · ') : 'Add a resume and target roles.'} action={() => onNavigate('candidates')} />
          <ReadinessItem complete={completedSteps.includes('build-search-config')} number="3" title={completedSteps.includes('build-search-config') ? 'Search config completed' : 'Review search settings'} copy="Confirm location, salary, sources, and filters." action={() => onNavigate('workflows')} />
          <div className="readiness-note"><Zap size={16} /><p>Once configured, every workflow uses <strong>{settings.model}</strong> until you change it.</p></div>
        </div>
      </section>
    </>
  );
}

function Metric({ number, label, note }) {
  return <div className="metric"><span className="metric-number">{number}</span><strong>{label}</strong><small>{note}</small></div>;
}

function ReadinessItem({ complete, number, title, copy, action }) {
  return (
    <button className="readiness-item" onClick={action}>
      <span className={`step-box ${complete ? 'complete' : ''}`}>{complete ? <Check size={14} /> : number}</span>
      <span><strong>{title}</strong><small>{copy}</small></span>
      <ArrowRight size={15} />
    </button>
  );
}

function WorkflowStudio({ settings, activeCandidate, onWorkflowComplete, onUpdateCandidateSites, onUpdateCandidateSalary, onRemoveCandidateJob, onSelectCandidateJob, onUpdateCandidateJob, onUpdateCandidateJobStage, onOpenSettings, onOpenCandidates }) {
  const [selected, setSelected] = useState(() => lastWorkflowFor(activeCandidate));
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [runMeta, setRunMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [customSiteDraft, setCustomSiteDraft] = useState('');
  const [customSiteError, setCustomSiteError] = useState('');
  const [selectedJobId, setSelectedJobId] = useState('');
  const [submissionStage, setSubmissionStage] = useState('submitted');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [salarySuggestionLoading, setSalarySuggestionLoading] = useState(false);
  const [salarySuggestionError, setSalarySuggestionError] = useState('');
  const salaryInferenceAttempted = useRef(new Set());
  const [runState, setRunState] = useState({ status: 'idle' });
  const [completionNotice, setCompletionNotice] = useState(null);
  const completionTimer = useRef(null);
  const runController = useRef(null);
  const activeSearchSources = SEARCH_SOURCES.filter((source) => (settings.searchSources || DEFAULT_SEARCH_SOURCES).includes(source.id));
  const savedProfileOutput = activeCandidate?.workflowOutputs?.['setup-candidate'] || '';
  const savedSearchConfig = activeCandidate?.workflowOutputs?.['build-search-config'] || '';
  const profileReady = Boolean(activeCandidate?.resumeText);
  const searchConfigReady = Boolean(savedSearchConfig);
  const jobSearchReady = profileReady && searchConfigReady;
  const savedJobs = activeCandidate?.jobs || [];
  const selectedJob = savedJobs.find((job) => job.id === selectedJobId) || null;

  function candidateSourceFor(workflowId) {
    if (!activeCandidate) return '';
    return ['setup-candidate', 'build-search-config'].includes(workflowId) ? activeCandidate.resumeText || '' : '';
  }

  function chooseWorkflow(workflow) {
    window.clearTimeout(completionTimer.current);
    setSelected(workflow);
    setInput(candidateSourceFor(workflow.id));
    setOutput('');
    setError('');
    setUploadedFile(null);
    setCustomSiteDraft('');
    setCustomSiteError('');
    setSelectedJobId('');
    setRunState({ status: 'idle' });
    setCompletionNotice(null);
  }

  useEffect(() => () => { window.clearTimeout(completionTimer.current); runController.current?.abort(); }, []);
  useEffect(() => {
    window.clearTimeout(completionTimer.current);
    const persistedWorkflow = lastWorkflowFor(activeCandidate);
    const persistedOutput = workflowOutputText(activeCandidate?.workflowOutputs?.[persistedWorkflow.id]);
    setOutput('');
    setError('');
    setRunState({ status: 'idle' });
    setCompletionNotice(null);
    setUploadedFile(null);
    setCustomSiteDraft('');
    setCustomSiteError('');
    setSelected(persistedWorkflow);
    setSelectedJobId(activeCandidate?.lastJobId || '');
    setOutput(persistedOutput);
    setRunState(persistedOutput ? { status: 'complete', workflow: persistedWorkflow.title, finishedAt: new Date() } : { status: 'idle' });
    const persistedJob = (activeCandidate?.jobs || []).find((job) => job.id === activeCandidate?.lastJobId);
    setInput(persistedJob ? [`${persistedJob.title}${persistedJob.company ? ` — ${persistedJob.company}` : ''}`, persistedJob.url, persistedJob.summary].filter(Boolean).join('\n\n') : candidateSourceFor(persistedWorkflow.id));
  }, [activeCandidate?.id, activeCandidate?.lastWorkflowId]);

  useEffect(() => {
    if (selected.id !== 'find-me-a-job' || !activeCandidate || !savedSearchConfig) return;
    const inferenceKey = `${activeCandidate.id}:${savedSearchConfig.length}`;
    if (activeCandidate.salaryExpectationEur) {
      salaryInferenceAttempted.current.add(inferenceKey);
      return;
    }
    if (salaryInferenceAttempted.current.has(inferenceKey) || salarySuggestionLoading) return;
    salaryInferenceAttempted.current.add(inferenceKey);
    setSalarySuggestionLoading(true);
    setSalarySuggestionError('');
    api('/api/infer-salary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeText: activeCandidate.resumeText, searchConfig: savedSearchConfig }),
    })
      .then((result) => onUpdateCandidateSalary(activeCandidate.id, result.salaryExpectationEur, result.basis))
      .catch((error) => setSalarySuggestionError(error.message))
      .finally(() => setSalarySuggestionLoading(false));
  }, [selected.id, activeCandidate?.id, activeCandidate?.salaryExpectationEur, savedSearchConfig]);

  async function uploadResume(file) {
    if (!file) return;
    setUploadLoading(true);
    setUploadedFile(null);
    setError('');
    const body = new FormData();
    body.append('file', file);
    try {
      const response = await fetch('/api/extract-resume', { method: 'POST', body, credentials: 'include' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error?.message || `Upload failed (${response.status})`);
      setInput(result.text);
      setUploadedFile(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploadLoading(false);
    }
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragActive(false);
    uploadResume(event.dataTransfer.files?.[0]);
  }

  function addCandidateSearchSite() {
    if (!activeCandidate) return setCustomSiteError('Choose a profile before adding search sites.');
    const raw = customSiteDraft.trim();
    if (!raw) return;
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) throw new Error('invalid');
      url.hash = '';
      const normalized = url.toString().replace(/\/$/, '');
      const existing = activeCandidate.customSearchSites || [];
      if (!existing.includes(normalized)) onUpdateCandidateSites(activeCandidate.id, [...existing, normalized]);
      setCustomSiteDraft('');
      setCustomSiteError('');
    } catch {
      setCustomSiteError('Enter a valid site such as jobs.example.com or https://example.com/careers.');
    }
  }

  function removeCandidateSearchSite(site) {
    if (!activeCandidate) return;
    onUpdateCandidateSites(activeCandidate.id, (activeCandidate.customSearchSites || []).filter((item) => item !== site));
  }

  function chooseJob(jobId) {
    setSelectedJobId(jobId);
    if (activeCandidate) onSelectCandidateJob(activeCandidate.id, jobId);
    const job = savedJobs.find((item) => item.id === jobId);
    if (!job) return;
    setSubmissionStage(job.stage && job.stage !== 'new' ? job.stage : 'submitted');
    setInput([`${job.title}${job.company ? ` — ${job.company}` : ''}`, job.url, job.summary].filter(Boolean).join('\n\n'));
    setError('');
    if (selected.id === 'add-job' && !job.summary) {
      setSummaryLoading(true);
      api('/api/summarize-job', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: job.url }) })
        .then((result) => { if (result.summary) onUpdateCandidateJob(activeCandidate.id, job.id, result.summary); })
        .catch((error) => setError(error.message))
        .finally(() => setSummaryLoading(false));
    }
  }

  function markJobNotInterested(jobId) {
    if (!activeCandidate) return;
    onRemoveCandidateJob(activeCandidate.id, jobId);
    if (selectedJobId === jobId) {
      setSelectedJobId('');
      setInput('');
    }
  }

  async function run() {
    runController.current?.abort();
    const controller = new AbortController();
    runController.current = controller;
    const runCandidateId = activeCandidate?.id || '';
    setLoading(true);
    setError('');
    setOutput('');
    setRunMeta(null);
    window.clearTimeout(completionTimer.current);
    setCompletionNotice(null);
    setRunState({ status: 'running', workflow: selected.title });
    if (selected.id === 'mark-submitted' || selected.id === 'job-stats') {
      const finishedAt = new Date();
      if (selected.id === 'mark-submitted') {
        if (!activeCandidate || !selectedJobId) {
          setError('Choose a saved job before tracking its submission.');
          setRunState({ status: 'failed', workflow: selected.title });
          setLoading(false);
          return;
        }
        onUpdateCandidateJobStage(activeCandidate.id, selectedJobId, submissionStage);
        const job = (activeCandidate.jobs || []).find((item) => item.id === selectedJobId);
        const localOutput = `# Application status\n\n**${job?.title || 'Selected role'}** is now **${submissionStage}**.\n\nThis status was saved to the local pipeline at ${finishedAt.toLocaleString()}.`;
        setOutput(localOutput);
        setRunMeta({ model: 'local', tokens: 0 });
        setRunState({ status: 'complete', workflow: selected.title, finishedAt });
        onWorkflowComplete(selected.id, localOutput, [], selectedJobId, runCandidateId);
      } else {
        const jobs = activeCandidate?.jobs || [];
        const count = (stage) => jobs.filter((job) => (job.stage || 'new') === stage).length;
        const localOutput = `# Pipeline stats\n\n- Total saved roles: ${jobs.length}\n- New: ${count('new')}\n- Submitted: ${count('submitted')}\n- Interviewing: ${count('interviewing')}\n- Offered: ${count('offered')}\n- Rejected: ${count('rejected')}\n- Withdrawn: ${count('withdrawn')}`;
        setOutput(localOutput);
        setRunMeta({ model: 'local', tokens: 0 });
        setRunState({ status: 'complete', workflow: selected.title, finishedAt });
        onWorkflowComplete(selected.id, localOutput, [], '', runCandidateId);
      }
      setLoading(false);
      return;
    }
    const savedWorkflowContext = selected.id === 'find-me-a-job'
      ? `\n\nSTEP 1 — SAVED PROFILE\n${savedProfileOutput || 'Use the saved CV and profile details above.'}\n\nSTEP 2 — SAVED SEARCH CONFIGURATION\n${savedSearchConfig}`
      : '';
    const candidateContext = activeCandidate
      ? `ACTIVE PROFILE\nName: ${activeCandidate.name}\nTarget roles: ${activeCandidate.targetRoles.join(', ')}\nSalary expectation: ${activeCandidate.salaryExpectationEur ? `€${Number(activeCandidate.salaryExpectationEur).toLocaleString('en-IE')} gross per year` : 'not specified'}\nCV file: ${activeCandidate.resumeFilename || 'pasted text'}\n\nCV CONTENT\n${activeCandidate.resumeText}${savedWorkflowContext}\n\nWORKFLOW INPUT\n${input || 'Use the saved workflow information above.'}`
      : input;
    try {
      const result = await api('/api/run-command', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: selected.id,
          input: candidateContext,
          jobUrl: selectedJob?.url || '',
          customSearchSites: selected.id === 'find-me-a-job' ? activeCandidate?.customSearchSites || [] : [],
          salaryExpectationEur: selected.id === 'find-me-a-job' ? activeCandidate?.salaryExpectationEur || null : null,
        }),
      });
      setOutput(result.content);
      setRunMeta({ model: result.model, tokens: result.usage?.total_tokens, sourceResults: result.sourceResults || [] });
      const finishedAt = new Date();
      const nextWorkflow = nextWorkflowFor(WORKFLOWS, selected.id);
      setRunState({ status: 'complete', workflow: selected.title, finishedAt });
      setCompletionNotice({ workflow: selected.title, nextWorkflow, finishedAt });
      const parsedJobs = Array.isArray(result.jobs) ? result.jobs : (selected.id === 'find-me-a-job' ? extractJobLeads(result.content) : []);
      onWorkflowComplete(selected.id, result.content, parsedJobs, selectedJobId, runCandidateId);
      if (selected.id === 'mark-submitted' && selectedJobId && runCandidateId) onUpdateCandidateJobStage(runCandidateId, selectedJobId, submissionStage);
      completionTimer.current = window.setTimeout(() => setCompletionNotice(null), 12000);
    } catch (err) {
      if (err.name === 'AbortError') {
        setError('The run was cancelled.');
        setRunState({ status: 'failed', workflow: selected.title });
      } else {
      setError(err.message);
      setRunState({ status: 'failed', workflow: selected.title });
      }
    } finally {
      if (runController.current === controller) runController.current = null;
      setLoading(false);
    }
  }

  async function copyOutput() {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <>
      <PageIntro eyebrow="AGENT WORKFLOWS" title={<>One job.<br /><span>One focused agent.</span></>} copy="Choose a workflow, provide the source material, and run it with your selected OpenRouter model." />
      <section className={`workflow-candidate-bar ${activeCandidate ? 'active' : ''}`}>
        {activeCandidate ? <><span className="candidate-initials">{activeCandidate.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</span><span><small>ACTIVE PROFILE</small><strong>{activeCandidate.name}</strong><em>{activeCandidate.targetRoles.join(' · ')}</em></span><span className="workflow-progress-count">{(activeCandidate.completedSteps || []).length}/{WORKFLOWS.length} STEPS</span></> : <><Users size={18} /><span><small>NO ACTIVE PROFILE</small><strong>Runs will not have a saved CV or progress</strong></span></>}
        <button type="button" onClick={onOpenCandidates}>{activeCandidate ? 'Switch profile' : 'Choose profile'} <ArrowRight size={14} /></button>
      </section>
      <div className="studio-grid">
        <aside className="workflow-selector panel">
          {WORKFLOWS.map((workflow) => {
            const Icon = workflow.icon;
            const completed = (activeCandidate?.completedSteps || []).includes(workflow.id);
            return (
              <button key={workflow.id} className={`${selected.id === workflow.id ? 'selected' : ''} ${completed ? 'completed' : ''}`} onClick={() => chooseWorkflow(workflow)}>
                <span>{completed ? <CircleCheckBig size={14} /> : workflow.number}</span><Icon size={16} /><strong>{workflow.title}</strong>
              </button>
            );
          })}
        </aside>
        <section className="runner panel">
          <div className="runner-heading">
            <div className="runner-icon"><selected.icon size={22} /></div>
            <div><span className="eyebrow">WORKFLOW {selected.number}</span><h2>{selected.title}</h2><p>{selected.description}</p></div>
          </div>
          {selected.id === 'setup-candidate' && (
            <div className="resume-upload-wrap">
              <span className="field-label">RESUME FILE</span>
              {uploadedFile ? (
                <div className="file-loaded">
                  <span className="file-loaded-icon"><FileCheck size={20} /></span>
                  <span className="file-loaded-copy"><strong>{uploadedFile.filename}</strong><small>{uploadedFile.type} · {uploadedFile.characters.toLocaleString()} characters extracted</small></span>
                  <button type="button" onClick={() => { setUploadedFile(null); setInput(''); }} aria-label="Remove uploaded resume"><X size={16} /></button>
                </div>
              ) : (
                <label
                  className={`resume-dropzone ${dragActive ? 'drag-active' : ''} ${uploadLoading ? 'loading' : ''}`}
                  htmlFor="resume-file"
                  onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={handleDrop}
                >
                  {uploadLoading ? <RefreshCw className="spin" size={22} /> : <UploadCloud size={22} />}
                  <span><strong>{uploadLoading ? 'Reading resume…' : 'Drop a resume here or choose a file'}</strong><small>Markdown, TXT, PDF, or DOCX · 10 MB maximum</small></span>
                  <span className="button secondary compact">Choose file</span>
                  <input id="resume-file" type="file" accept=".md,.markdown,.txt,.pdf,.docx" onChange={(event) => uploadResume(event.target.files?.[0])} disabled={uploadLoading} />
                </label>
              )}
              <div className="upload-divider"><span>OR PASTE BELOW</span></div>
            </div>
          )}
          {selected.id !== 'add-job' && <><label className="field-label" htmlFor="agent-input"><span>{selected.id === 'find-me-a-job' ? 'ADDITIONAL SEARCH NOTES (OPTIONAL)' : 'SOURCE MATERIAL'}</span>{activeCandidate && ['setup-candidate', 'build-search-config'].includes(selected.id) && input === activeCandidate.resumeText && <strong>LOADED FROM {activeCandidate.name.toUpperCase()}'S CV</strong>}</label><textarea id="agent-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder={selected.placeholder} rows={selected.id === 'find-me-a-job' ? 4 : 12} /></>}
          {selected.id === 'find-me-a-job' && (
            <>
              <div className="salary-expectation">
                <div className="salary-expectation-heading"><span className="salary-symbol">€</span><span><strong>Salary expectation</strong><small>Minimum annual gross salary · saved with {activeCandidate?.name || 'the profile'}</small></span>{salarySuggestionLoading && <RefreshCw className="spin" size={15} />}</div>
                <div className="salary-input-wrap"><span>€</span><input type="number" min="10000" max="1000000" step="1000" value={activeCandidate?.salaryExpectationEur || ''} onChange={(event) => activeCandidate && onUpdateCandidateSalary(activeCandidate.id, event.target.value ? Number(event.target.value) : '', '')} placeholder={salarySuggestionLoading ? 'Estimating from previous analysis…' : 'Enter annual amount'} /><em>EUR / YEAR</em></div>
                {activeCandidate?.salaryExpectationBasis && <small className="salary-basis">AI suggestion: {activeCandidate.salaryExpectationBasis} You can overwrite it.</small>}
                {salarySuggestionError && <small className="custom-site-error">{salarySuggestionError} Enter an amount manually.</small>}
              </div>
              <div className="search-readiness">
                <div className={profileReady ? 'ready' : ''}><span>{profileReady ? <Check size={15} /> : '01'}</span><strong>Profile and CV</strong><small>{profileReady ? `${activeCandidate.name} is loaded.` : 'Choose or create a profile.'}</small></div>
                <div className={searchConfigReady ? 'ready' : ''}><span>{searchConfigReady ? <Check size={15} /> : '02'}</span><strong>Search configuration</strong><small>{searchConfigReady ? 'Saved output from Step 2 is loaded.' : 'Run Step 2 once to save the search configuration.'}</small></div>
              </div>
              <div className="active-sources">
              <div className="active-sources-heading"><span><Globe2 size={16} /><strong>Search sources</strong></span><button type="button" onClick={onOpenSettings}>Configure <ArrowRight size={14} /></button></div>
              <div className="active-source-list">{activeSearchSources.map((source) => <span key={source.id}>{source.label}</span>)}</div>
              <small>Default sources come from Settings. Custom sites below are saved only with the active profile. Step 3 searches both sets.</small>
              <div className="candidate-sites-editor">
                <div className="source-selector-heading"><span className="field-label">{activeCandidate ? `${activeCandidate.name.toUpperCase()} — CUSTOM SITES` : 'CUSTOM SITES'}</span><strong>{(activeCandidate?.customSearchSites || []).length} OF 20</strong></div>
                {activeCandidate ? <><div className="custom-site-entry"><Link2 size={16} /><input value={customSiteDraft} onChange={(event) => { setCustomSiteDraft(event.target.value); setCustomSiteError(''); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addCandidateSearchSite(); } }} placeholder="jobs.example.com or a careers-page URL" /><button type="button" className="button secondary compact" onClick={addCandidateSearchSite} disabled={!customSiteDraft.trim() || (activeCandidate.customSearchSites || []).length >= 20}><Plus size={15} /> Add site</button></div>{customSiteError && <small className="custom-site-error">{customSiteError}</small>}{(activeCandidate.customSearchSites || []).length > 0 ? <div className="custom-site-list">{activeCandidate.customSearchSites.map((site) => <div key={site}><span><Globe2 size={14} /><strong>{site.replace(/^https?:\/\//, '')}</strong></span><button type="button" onClick={() => removeCandidateSearchSite(site)} aria-label={`Remove ${site} from ${activeCandidate.name}`}><X size={14} /></button></div>)}</div> : <div className="candidate-sites-empty">No custom sites added for this profile.</div>}</> : <button type="button" className="candidate-sites-empty action" onClick={onOpenCandidates}>Choose a profile to add custom search sites <ArrowRight size={14} /></button>}
              </div>
              </div>
            </>
          )}
          {['add-job', 'write-cover-letter', 'mark-submitted'].includes(selected.id) && (
            <div className={`job-picker ${selected.id === 'add-job' ? 'analyze-job-picker' : ''}`}>
              <label className="field-label" htmlFor="saved-job-select"><span>JOBS FOUND IN STEP 3</span><strong>{savedJobs.length} SAVED</strong></label>
              <select id="saved-job-select" value={selectedJobId} onChange={(event) => chooseJob(event.target.value)} disabled={!savedJobs.length}>
                <option value="">{savedJobs.length ? 'Select a job to process…' : 'No saved jobs — run Step 3 first'}</option>
                {savedJobs.map((job) => <option key={job.id} value={job.id}>{job.title}{job.company ? ` — ${job.company}` : ''}</option>)}
              </select>
              {savedJobs.length > 0 && <div className="job-option-list">{savedJobs.map((job) => <div key={job.id} className={`job-option-row ${selectedJobId === job.id ? 'selected' : ''}`} onClick={() => chooseJob(job.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') chooseJob(job.id); }} role="button" tabIndex={0}><span><strong>{job.title}</strong><small>{job.company || job.url}</small></span><button type="button" onClick={(event) => { event.stopPropagation(); markJobNotInterested(job.id); }} aria-label={`Not interested in ${job.title}`}>Not interested <X size={13} /></button></div>)}</div>}
              <small>{savedJobs.length ? 'Select a posting to load its details below.' : 'Start the Step 3 job search to populate this list for the active profile.'}</small>
              {selected.id === 'mark-submitted' && selectedJob && <div className="selected-job-details"><div className="selected-job-details-heading"><span className="eyebrow">APPLICATION STATUS</span></div><h3>{selectedJob.title}</h3><label className="field-label" htmlFor="submission-stage">SET STAGE</label><select id="submission-stage" value={submissionStage} onChange={(event) => setSubmissionStage(event.target.value)}><option value="submitted">Submitted</option><option value="interviewing">Interviewing</option><option value="offered">Offered</option><option value="rejected">Rejected</option><option value="withdrawn">Withdrawn</option></select><small>Running this step saves the selected stage to the local application pipeline.</small></div>}
              {selected.id === 'add-job' && <div className="selected-job-details"><div className="selected-job-details-heading"><span className="eyebrow">SELECTED JOB</span>{selectedJob && <span className="selected-job-state">{summaryLoading ? 'SUMMARIZING…' : 'READY TO ANALYZE'}</span>}</div>{selectedJob ? <><h3>{selectedJob.title}</h3>{selectedJob.company && <p className="selected-job-company">{selectedJob.company}</p>}<a href={selectedJob.url} target="_blank" rel="noreferrer">{selectedJob.url} <ArrowRight size={13} /></a><div className="selected-job-summary">{summaryLoading ? 'Reading the posting and preparing a summary…' : (selectedJob.summary || 'No summary was returned. Open the posting link to review the full role description.')}</div></> : <div className="selected-job-empty">Choose a job above to view its role details and prepare it for analysis.</div>}</div>}
            </div>
          )}
          {error && <div className="error-banner"><span>{error}</span>{!settings.apiKeyConfigured && <button onClick={onOpenSettings}>Open settings</button>}</div>}
          <div className="runner-actions">
            <div className="runner-model"><span className="model-pulse" /><span>RUNNING ON</span><strong>{settings.model}</strong></div>
            {loading && <button className="button secondary" onClick={() => runController.current?.abort()}>Cancel</button>}
            <button className="button primary" onClick={run} disabled={loading || (selected.id === 'find-me-a-job' ? !jobSearchReady : (!input.trim() && !activeCandidate?.resumeText))}>{loading ? <RefreshCw className="spin" size={16} /> : <Play size={16} fill="currentColor" />}{loading ? (selected.id === 'find-me-a-job' ? 'Searching…' : 'Running…') : (selected.id === 'find-me-a-job' ? 'Start job search' : 'Run agent')}</button>
          </div>
          {runState.status !== 'idle' && (
            <div className={`process-status ${runState.status}`} role="status" aria-live="polite">
              <span className="process-status-icon">
                {runState.status === 'running' && <RefreshCw className="spin" size={18} />}
                {runState.status === 'complete' && <CircleCheckBig size={19} />}
                {runState.status === 'failed' && <X size={19} />}
              </span>
              <span className="process-status-copy">
                <strong>{runState.status === 'running' ? 'Agent is running' : runState.status === 'complete' ? 'Process finished' : 'Process stopped'}</strong>
                <small>
                  {runState.status === 'running' && `${runState.workflow} is processing the source material.`}
                  {runState.status === 'complete' && `${runState.workflow} completed at ${runState.finishedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`}
                  {runState.status === 'failed' && 'The agent did not finish. Review the error above and run it again.'}
                </small>
              </span>
              <span className="process-status-label">{runState.status === 'running' ? 'IN PROGRESS' : runState.status === 'complete' ? 'COMPLETED' : 'FAILED'}</span>
            </div>
          )}
        </section>
      </div>
      {(output || loading) && (
        <section className={`output-panel panel output-${selected.id}`}>
          <div className="panel-heading">
            <div><span className="eyebrow">AGENT OUTPUT</span><h2>{selected.title}</h2></div>
            {output && <div className="output-heading-actions"><span className="complete-badge"><CircleCheckBig size={15} /> Completed</span><button className="button secondary compact" onClick={copyOutput}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Copied' : 'Copy'}</button></div>}
          </div>
          {loading ? <div className="output-loading"><span /><span /><span /></div> : selected.id !== 'find-me-a-job' && <pre>{output}</pre>}
          {!loading && selected.id === 'find-me-a-job' && savedJobs.length > 0 && (
            <div className="found-role-links">
              <div className="found-role-links-heading"><span className="eyebrow">ROLES FOUND</span><strong>{savedJobs.length} SAVED · {savedJobs.filter((job) => (job.verification?.status || job.verificationStatus) === 'page-fetched').length} PAGES FETCHED</strong></div>
              <div className="found-role-links-list">
                {savedJobs.map((job) => (
                  <article className="found-role-card" key={job.id}>
                    <div className="found-role-card-heading"><span><strong>{job.title}</strong><small>{job.company || 'Company not stated'}</small></span><span className={`active-role-status ${verificationLabel(job).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z-]/g, '')}`}><span />{verificationLabel(job)}</span></div>
                    <div className="found-role-facts">
                      <span><small>LOCATION</small><strong>{job.location || 'Not stated'}</strong></span>
                      <span><small>WORK MODE</small><strong>{job.workMode || 'Not stated'}</strong></span>
                      <span><small>COMPENSATION</small><strong>{job.compensation || 'Not stated'}</strong></span>
                      <span><small>SOURCE</small><strong>{job.source || 'Direct posting'}</strong></span>
                    </div>
                    <div className="found-role-dates"><span>Posted: <strong>{job.postedDate || 'Not stated'}</strong></span><span>Closing: <strong>{job.closingDate || 'Not stated'}</strong></span><span>Checked: <strong>{job.checkedDate || 'Previously saved'}</strong></span></div>
                    {job.evidence && <p>{job.evidence}</p>}
                    <a href={job.url} target="_blank" rel="noreferrer">Open role <ArrowRight size={14} /></a>
                  </article>
                ))}
              </div>
            </div>
          )}
          {!loading && selected.id === 'find-me-a-job' && savedJobs.length === 0 && <div className="no-verified-roles"><Search size={20} /><strong>No structured job leads found</strong><small>Use Copy to inspect the full search report and source details.</small></div>}
          {runMeta && <div className="output-meta"><span>{runMeta.model}</span>{runMeta.tokens && <span>{runMeta.tokens.toLocaleString()} tokens</span>}{runMeta.sourceResults?.length > 0 && <details className="source-run-summary"><summary>{runMeta.sourceResults.filter((source) => String(source.status || '').startsWith('agent-')).filter((source) => source.status === 'agent-complete').length}/{runMeta.sourceResults.filter((source) => String(source.status || '').startsWith('agent-')).length} agents completed</summary><div>{runMeta.sourceResults.map((source) => <span key={source.name} className={source.status === 'agent-complete' || source.status === 'fetch-ok' ? 'source-run-ok' : 'source-run-failed'}>{source.name}: {source.status}{source.error ? ` — ${source.error}` : ''}</span>)}</div></details>}</div>}
        </section>
      )}
      {completionNotice && (
        <div className="completion-toast" role="status" aria-live="assertive">
          <span className="completion-toast-icon"><CircleCheckBig size={24} /></span>
          <span className="completion-toast-copy">
            <strong>{completionNotice.nextWorkflow ? 'Step completed' : 'All steps completed'}</strong>
            <small>{completionNotice.workflow} finished successfully. {completionNotice.nextWorkflow ? `Next: ${completionNotice.nextWorkflow.number} · ${completionNotice.nextWorkflow.title}.` : 'The full workflow is complete.'}</small>
            {completionNotice.nextWorkflow && <button type="button" className="completion-next" onClick={() => chooseWorkflow(completionNotice.nextWorkflow)}>Start next step <ArrowRight size={14} /></button>}
          </span>
          <button type="button" className="completion-dismiss" onClick={() => setCompletionNotice(null)} aria-label="Dismiss completion message"><X size={16} /></button>
          <span className="completion-timer" />
        </div>
      )}
    </>
  );
}

function Candidates({ candidates, activeCandidate, onAddCandidate, onUpdateCandidate, onSelectCandidate, onRestoreBackup, onStart }) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [targetRoles, setTargetRoles] = useState('');
  const [resumeText, setResumeText] = useState('');
  const [resumeFilename, setResumeFilename] = useState('');
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState('');
  const [editing, setEditing] = useState(null);
  const [editName, setEditName] = useState('');
  const [editRoles, setEditRoles] = useState('');
  const [editResume, setEditResume] = useState('');
  const [restoreStatus, setRestoreStatus] = useState('');

  async function uploadCandidateResume(file) {
    if (!file) return;
    setUploading(true);
    setFormError('');
    const body = new FormData();
    body.append('file', file);
    try {
      const response = await fetch('/api/extract-resume', { method: 'POST', body, credentials: 'include' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error?.message || `Upload failed (${response.status})`);
      setResumeText(result.text);
      setResumeFilename(result.filename);
    } catch (error) {
      setFormError(error.message);
    } finally {
      setUploading(false);
    }
  }

  function addCandidate(event) {
    event.preventDefault();
    const roles = targetRoles.split(',').map((role) => role.trim()).filter(Boolean);
    if (!roles.length) return setFormError('Add at least one target role.');
    if (!resumeText.trim()) return setFormError('Upload or paste a CV.');
    onAddCandidate({ name: name.trim(), targetRoles: roles, resumeText: resumeText.trim(), resumeFilename });
    setShowForm(false);
    setName('');
    setTargetRoles('');
    setResumeText('');
    setResumeFilename('');
    setFormError('');
  }
  function beginEdit(candidate) {
    setEditing(candidate);
    setEditName(candidate.name || '');
    setEditRoles((candidate.targetRoles || []).join(', '));
    setEditResume(candidate.resumeText || '');
  }
  function saveEdit(event) {
    event.preventDefault();
    const roles = editRoles.split(',').map((role) => role.trim()).filter(Boolean);
    if (!editName.trim() || !roles.length) return;
    onUpdateCandidate(editing.id, { name: editName.trim(), targetRoles: roles, resumeText: editResume.trim() || editing.resumeText });
    setEditing(null);
  }
  function exportBackup() {
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), candidates }, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = href; link.download = 'hire-me-agents-profile-backup.json'; link.click();
    URL.revokeObjectURL(href);
  }
  async function restoreBackup(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return setRestoreStatus('Backup must be smaller than 10 MB.');
    try {
      const payload = JSON.parse(await file.text());
      const count = onRestoreBackup(payload);
      setRestoreStatus(`${count} profile${count === 1 ? '' : 's'} available after merging the backup.`);
    } catch (error) {
      setRestoreStatus(error.message || 'The backup could not be restored.');
    }
  }
  return (
    <>
      <PageIntro eyebrow="PROFILES" title={<>Profiles built for<br /><span>repeatable searches.</span></>} copy="Each profile keeps its own CV, target roles, custom search sites, workflow progress, and application history." action={<span className="page-actions"><label className="button secondary" htmlFor="profile-backup-input">Restore backup<input id="profile-backup-input" type="file" accept="application/json,.json" onChange={restoreBackup} /></label><button className="button secondary" onClick={exportBackup} disabled={!candidates.length}>Export backup</button><button className="button primary" onClick={() => setShowForm(true)}><Plus size={16} /> Add profile</button></span>} />
      {restoreStatus && <div className="restore-status" role="status">{restoreStatus}</div>}
      {candidates.length === 0 ? <EmptyState icon={Users} title="No profiles yet" copy="Add a profile to keep a CV, target roles, custom sites, and workflow progress together." action="Add first profile" onAction={() => setShowForm(true)} /> : (
        <section className="candidate-grid">
          {candidates.map((candidate) => {
            const selected = candidate.id === activeCandidate?.id;
            const completed = (candidate.completedSteps || []).length;
            return <article className={`candidate-card panel ${selected ? 'selected' : ''}`} key={candidate.id}><div className="candidate-card-top"><span className="candidate-initials large">{candidate.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</span>{selected && <span className="active-candidate-label"><Check size={13} /> ACTIVE</span>}</div><h2>{candidate.name}</h2><p>{candidate.targetRoles.join(' · ')}</p><div className="candidate-file"><FileText size={14} /><span>{candidate.resumeFilename || 'Pasted CV'}</span></div><div className="candidate-site-count"><Globe2 size={14} /><span><strong>{(candidate.customSearchSites || []).length}</strong> custom search {(candidate.customSearchSites || []).length === 1 ? 'site' : 'sites'}</span></div><div className="candidate-card-progress"><span><strong>{completed}</strong>/{WORKFLOWS.length} steps</span><span><i style={{ width: `${(completed / WORKFLOWS.length) * 100}%` }} /></span></div><div className="candidate-card-actions"><button className="button secondary compact" onClick={() => beginEdit(candidate)}>Edit</button>{selected ? <button className="button primary" onClick={onStart}><Play size={14} fill="currentColor" /> Continue</button> : <button className="button secondary" onClick={() => onSelectCandidate(candidate.id)}>Select profile</button>}</div></article>;
          })}
        </section>
      )}
      {showForm && <div className="modal-wrap"><button className="modal-scrim" onClick={() => setShowForm(false)} aria-label="Close" /><form className="modal candidate-modal panel" onSubmit={addCandidate}><div className="panel-heading"><div><span className="eyebrow">NEW PROFILE</span><h2>Create reusable profile</h2></div><button type="button" className="icon-button" onClick={() => setShowForm(false)}><X size={18} /></button></div><div className="candidate-form-grid"><div><label className="field-label" htmlFor="candidate-name">FULL NAME</label><input id="candidate-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Profile name" required /></div><div><label className="field-label" htmlFor="candidate-roles">TARGET ROLES</label><input id="candidate-roles" value={targetRoles} onChange={(event) => setTargetRoles(event.target.value)} placeholder="Product Manager, Program Manager" required /><small className="field-help">Separate multiple role types with commas.</small></div></div><label className="field-label">CV FILE</label><label className={`candidate-file-upload ${resumeFilename ? 'loaded' : ''}`} htmlFor="candidate-file-input">{uploading ? <RefreshCw className="spin" size={20} /> : resumeFilename ? <FileCheck size={20} /> : <UploadCloud size={20} />}<span><strong>{uploading ? 'Reading CV…' : resumeFilename || 'Choose a CV file'}</strong><small>Markdown, TXT, PDF, or DOCX · 10 MB maximum</small></span><span className="button secondary compact">Browse</span><input id="candidate-file-input" type="file" accept=".md,.markdown,.txt,.pdf,.docx" onChange={(event) => uploadCandidateResume(event.target.files?.[0])} /></label><div className="upload-divider"><span>OR PASTE CV TEXT</span></div><textarea id="candidate-resume" rows={8} value={resumeText} onChange={(event) => { setResumeText(event.target.value); if (!event.target.value) setResumeFilename(''); }} placeholder="Paste the profile's CV…" required />{formError && <div className="source-warning"><X size={15} /> {formError}</div>}<div className="modal-actions"><button type="button" className="button secondary" onClick={() => setShowForm(false)}>Cancel</button><button className="button primary" disabled={uploading}>Create profile</button></div></form></div>}
      {editing && <div className="modal-wrap"><button className="modal-scrim" onClick={() => setEditing(null)} aria-label="Close" /><form className="modal candidate-modal panel" onSubmit={saveEdit}><div className="panel-heading"><div><span className="eyebrow">EDIT PROFILE</span><h2>Update profile details</h2></div><button type="button" className="icon-button" onClick={() => setEditing(null)}><X size={18} /></button></div><label className="field-label" htmlFor="edit-candidate-name">FULL NAME</label><input id="edit-candidate-name" value={editName} onChange={(event) => setEditName(event.target.value)} required /><label className="field-label" htmlFor="edit-candidate-roles">TARGET ROLES</label><input id="edit-candidate-roles" value={editRoles} onChange={(event) => setEditRoles(event.target.value)} required /><small className="field-help">Separate multiple role types with commas.</small><label className="field-label" htmlFor="edit-candidate-resume">CV TEXT</label><textarea id="edit-candidate-resume" rows={8} value={editResume} onChange={(event) => setEditResume(event.target.value)} required /><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setEditing(null)}>Cancel</button><button className="button primary">Save profile</button></div></form></div>}
    </>
  );
}

function Pipeline({ candidates, onUpdateStage, onStart }) {
  const jobs = candidates.flatMap((candidate) => (candidate.jobs || []).map((job) => ({ ...job, candidateName: candidate.name, candidateId: candidate.id })));
  const columns = [
    { id: 'new', label: 'NEW' },
    { id: 'submitted', label: 'SUBMITTED' },
    { id: 'interviewing', label: 'INTERVIEWING' },
    { id: 'offered', label: 'OFFERED' },
    { id: 'rejected', label: 'CLOSED / REJECTED' },
    { id: 'withdrawn', label: 'WITHDRAWN' },
  ];
  return (
    <>
      <PageIntro eyebrow="APPLICATION PIPELINE" title={<>Know what moved.<br /><span>Know what did not.</span></>} copy="Track each opportunity from first match through offer, rejection, or withdrawal." action={<button className="button primary" onClick={onStart}><Plus size={16} /> Add a job</button>} />
      <section className="pipeline-board">
        {columns.map((column) => { const columnJobs = jobs.filter((job) => (job.stage || 'new') === column.id); return <div className="pipeline-column" key={column.id}><div className="pipeline-heading"><strong>{column.label}</strong><span>{columnJobs.length}</span></div>{columnJobs.length ? columnJobs.map((job) => <details className="pipeline-card" key={`${job.candidateId}-${job.id}`}><summary><strong>{job.title}</strong><small>{job.company || 'Company not stated'} · {job.candidateName}</small></summary><div className="pipeline-detail"><span className="pipeline-verification">{verificationLabel(job)}</span>{job.url && <a href={job.url} target="_blank" rel="noreferrer">Open posting <ArrowRight size={13} /></a>}{Object.entries(job.artifacts || {}).filter(([, value]) => value).length > 0 && <div className="pipeline-artifacts"><small>Saved artifacts</small>{Object.entries(job.artifacts).filter(([, value]) => value).map(([key, value]) => <details className="pipeline-artifact" key={key}><summary>{key === 'coverLetter' ? 'Cover letter' : key === 'interviewPrep' ? 'Interview prep' : key === 'analysis' ? 'Job analysis' : key}</summary><pre>{value}</pre></details>)}</div>}<label className="pipeline-stage-label" htmlFor={`stage-${job.candidateId}-${job.id}`}>Stage</label><select id={`stage-${job.candidateId}-${job.id}`} value={job.stage || 'new'} onChange={(event) => onUpdateStage(job.candidateId, job.id, event.target.value)} aria-label={`Stage for ${job.title}`}>{columns.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></div></details>) : <div className="pipeline-empty">No jobs in this stage</div>}</div>; })}
      </section>
    </>
  );
}

function EmptyState({ icon: Icon, title, copy, action, onAction }) {
  return <section className="empty panel"><div className="empty-icon"><Icon size={27} /></div><h2>{title}</h2><p>{copy}</p><button className="button primary" onClick={onAction}>{action}<ArrowRight size={15} /></button></section>;
}

function SettingsPage({ settings, setSettings }) {
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState('');
  const [query, setQuery] = useState('');
  const [modelOpen, setModelOpen] = useState(false);
  const [form, setForm] = useState({ ...settings, apiKey: '' });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => setForm((current) => ({ ...current, ...settings })), [settings]);

  useEffect(() => {
    api('/api/models')
      .then(({ models: list }) => setModels(list))
      .catch((err) => setModelsError(err.message))
      .finally(() => setModelsLoading(false));
  }, []);

  const selectedModel = models.find((model) => model.id === form.model);
  const filteredModels = useMemo(() => {
    const needle = query.toLowerCase().trim();
    return models.filter((model) => !needle || `${model.name} ${model.id}`.toLowerCase().includes(needle)).slice(0, 80);
  }, [models, query]);

  async function saveSettings(event) {
    event.preventDefault();
    setSaving(true); setError(''); setSaved(false); setTestStatus(null);
    try {
      const next = await api('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: form.model, temperature: Number(form.temperature), maxTokens: Number(form.maxTokens), searchSources: form.searchSources || DEFAULT_SEARCH_SOURCES, apiKey: form.apiKey }),
      });
      setSettings(next);
      setForm((current) => ({ ...current, ...next, apiKey: '' }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  async function testModel() {
    setTesting(true); setError(''); setTestStatus(null);
    try {
      const result = await api('/api/test-model', { method: 'POST' });
      setTestStatus({ ok: true, message: `Connected to ${result.model}` });
    } catch (err) { setTestStatus({ ok: false, message: err.message }); } finally { setTesting(false); }
  }

  function chooseModel(model) {
    setForm((current) => ({ ...current, model: model.id }));
    setModelOpen(false);
    setQuery('');
    setTestStatus(null);
  }

  function toggleSource(sourceId) {
    setForm((current) => {
      const selected = current.searchSources || DEFAULT_SEARCH_SOURCES;
      const searchSources = selected.includes(sourceId)
        ? selected.filter((id) => id !== sourceId)
        : [...selected, sourceId];
      return { ...current, searchSources };
    });
    setSaved(false);
  }

  return (
    <>
      <PageIntro eyebrow="SETTINGS" title={<>Choose the engine.<br /><span>Keep the workflow.</span></>} copy="Your selected model is saved on the local server and used by every agent workflow." />
      <form className="settings-layout" onSubmit={saveSettings}>
        <section className="settings-main panel">
          <div className="settings-section-heading"><div className="setting-icon"><KeyRound size={19} /></div><div><h2>OpenRouter connection</h2><p>Requests are sent through your local server. The key is never added to the browser bundle.</p></div></div>
          <div className="field-group">
            <label className="field-label" htmlFor="api-key">API KEY</label>
            <div className="key-input"><input id="api-key" type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} placeholder={settings.apiKeyConfigured ? 'Key saved — enter a new key to replace it' : 'sk-or-v1-…'} autoComplete="off" /><span className={settings.apiKeyConfigured ? 'configured' : ''}>{settings.apiKeyConfigured ? 'SAVED' : 'NOT SET'}</span></div>
            <small className="field-help">You can also set <code>OPENROUTER_API_KEY</code> in the server environment.</small>
          </div>

          <div className="rule" />
          <div className="settings-section-heading"><div className="setting-icon"><Bot size={19} /></div><div><h2>Agent model</h2><p>All nine workflows use this model. Pricing below is per million tokens from OpenRouter.</p></div></div>
          <div className="field-group model-field">
            <label className="field-label">MODEL</label>
            <button type="button" className={`model-select ${modelOpen ? 'open' : ''}`} onClick={() => setModelOpen(!modelOpen)}>
              <span className="provider-badge">{form.model.split('/')[0]?.slice(0, 2).toUpperCase()}</span>
              <span><strong>{selectedModel?.name || form.model}</strong><small>{form.model}</small></span>
              <ChevronDown size={17} />
            </button>
            {modelOpen && (
              <div className="model-menu">
                <div className="model-search"><Search size={15} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models or providers…" /></div>
                <div className="model-options">
                  {modelsLoading && <div className="menu-state"><RefreshCw className="spin" size={16} /> Loading catalog…</div>}
                  {modelsError && <div className="menu-state error-text">{modelsError}</div>}
                  {!modelsLoading && !filteredModels.length && <div className="menu-state">No matching models</div>}
                  {filteredModels.map((model) => <button type="button" key={model.id} onClick={() => chooseModel(model)} className={model.id === form.model ? 'selected' : ''}><span className="provider-badge">{model.id.split('/')[0].slice(0, 2).toUpperCase()}</span><span><strong>{model.name}</strong><small>{model.id}</small></span><span className="model-cost"><strong>{formatPrice(model.promptPrice)}</strong><small>input</small></span>{model.id === form.model && <Check size={16} />}</button>)}
                </div>
              </div>
            )}
          </div>

          <div className="model-facts">
            <div><span>CONTEXT</span><strong>{formatContext(selectedModel?.contextLength)}</strong></div>
            <div><span>INPUT / 1M</span><strong>{formatPrice(selectedModel?.promptPrice)}</strong></div>
            <div><span>OUTPUT / 1M</span><strong>{formatPrice(selectedModel?.completionPrice)}</strong></div>
            <div><span>TOOLS</span><strong>{selectedModel?.supportsTools ? 'SUPPORTED' : 'MODEL DEPENDENT'}</strong></div>
          </div>

          <div className="rule" />
          <div className="settings-section-heading"><div className="setting-icon"><Globe2 size={19} /></div><div><h2>Default job-search sources</h2><p>Choose the shared sources used when Step 3 starts a job search. Profile-specific sites are managed in Step 3.</p></div></div>
          <div className="source-selector-heading"><span className="field-label">ENABLED SOURCES</span><strong>{(form.searchSources || DEFAULT_SEARCH_SOURCES).length} OF {SEARCH_SOURCES.length}</strong></div>
          <div className="source-selector">
            {SEARCH_SOURCES.map((source) => {
              const checked = (form.searchSources || DEFAULT_SEARCH_SOURCES).includes(source.id);
              return (
                <label key={source.id} className={checked ? 'selected' : ''}>
                  <input type="checkbox" checked={checked} onChange={() => toggleSource(source.id)} />
                  <span className="source-check">{checked && <Check size={14} />}</span>
                  <span><strong>{source.label}</strong><small>{source.description}</small></span>
                  <code>{source.id}</code>
                </label>
              );
            })}
          </div>
          {!(form.searchSources || []).length && <div className="source-warning"><X size={15} /> Select at least one built-in source before saving.</div>}

          <div className="rule" />
          <div className="settings-section-heading"><div className="setting-icon"><SlidersHorizontal size={19} /></div><div><h2>Generation controls</h2><p>Lower temperature gives job-search artifacts more consistent structure.</p></div></div>
          <div className="control-grid">
            <div className="field-group"><label className="field-label" htmlFor="temperature">TEMPERATURE <strong>{Number(form.temperature).toFixed(1)}</strong></label><input id="temperature" type="range" min="0" max="1.5" step="0.1" value={form.temperature} onChange={(event) => setForm({ ...form, temperature: event.target.value })} /><div className="range-labels"><span>PRECISE</span><span>CREATIVE</span></div></div>
            <div className="field-group"><label className="field-label" htmlFor="max-tokens">MAX OUTPUT TOKENS</label><input id="max-tokens" type="number" min="128" max="32768" step="128" value={form.maxTokens} onChange={(event) => setForm({ ...form, maxTokens: event.target.value })} /></div>
          </div>
          {error && <div className="error-banner">{error}</div>}
          {testStatus && <div className={`test-banner ${testStatus.ok ? 'success' : 'failure'}`}>{testStatus.ok ? <Check size={16} /> : <X size={16} />}<span>{testStatus.message}</span></div>}
          <div className="settings-actions"><button type="button" className="button secondary" onClick={testModel} disabled={testing || !settings.apiKeyConfigured}>{testing ? <RefreshCw className="spin" size={16} /> : <Activity size={16} />}{testing ? 'Testing…' : 'Test saved model'}</button><button className="button primary" disabled={saving || !(form.searchSources || []).length}>{saving ? <RefreshCw className="spin" size={16} /> : saved ? <Check size={16} /> : null}{saved ? 'Saved' : saving ? 'Saving…' : 'Save settings'}</button></div>
        </section>

        <aside className="settings-aside">
          <div className="panel active-model-card"><span className="eyebrow">ACTIVE MODEL</span><div className="active-model-mark"><Sparkles size={22} /></div><h3>{selectedModel?.name || form.model}</h3><code>{form.model}</code><p>This selection will apply to setup, search, tailoring, tracking, and interview preparation.</p><div className="live-line"><span className="model-pulse" /> READY TO SAVE</div></div>
          <div className="privacy-card"><ShieldCheck size={18} /><div><strong>LOCAL SETTINGS</strong><p>Saved in <code>.data/settings.json</code>, which is excluded from Git.</p></div></div>
        </aside>
      </form>
    </>
  );
}

export default App;
