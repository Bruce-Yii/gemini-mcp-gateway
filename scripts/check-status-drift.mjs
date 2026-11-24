#!/usr/bin/env node
/**
 * Status-drift check: the deployment log is the single source of truth for
 * “what runs in production”; AGENTS / STATUS must not advertise a different
 * build. This is offline and deterministic (no GitHub/Vercel API, no tokens).
 *
 * Usage:
 *   node scripts/check-status-drift.mjs --json
 *   node scripts/check-status-drift.mjs --expected 3dd206f
 *   node scripts/check-status-drift.mjs --documents AGENTS.md docs/STATUS.md
 *
 * Exit codes: 0 = aligned, 1 = drift found, 2 = usage/read error.
 */
import { readFile } from 'node:fs/promises';

const COMMIT_RE = /([0-9a-f]{7,40})/i;

/** Latest deploy commit from docs/DEPLOYMENTS.md (rows that are marked READY). */
export function parseDeploymentLog(text) {
  const rows = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    if (!/READY/.test(line)) continue;
    if (/未部署/.test(line)) continue;
    const commitMatch = /`([0-9a-f]{7,40})`/i.exec(line);
    if (!commitMatch) continue;
    rows.push({ commit: commitMatch[1].toLowerCase(), line });
  }
  const latest = rows.length ? rows[rows.length - 1].commit : null;
  return { rows, latest };
}

const REF_PATTERNS = [
  { label: 'production-deployed', re: /生产已部署\s*`([0-9a-f]{7,40})`/gi },
  { label: 'current-production', re: /当前生产[：:]\s*`([0-9a-f]{7,40})`/gi },
  { label: 'status-radar', re: /生产部署（Vercel）[^\n]*?\*\*\s*`([0-9a-f]{7,40})`[^*]*\*\*/gi },
  { label: 'healthz-verified', re: /healthz[^\n]*?commit=([0-9a-f]{7,40})/gi },
  { label: 'acceptance-current', re: /当前：[^\n]*?`([0-9a-f]{7,40})`/gi },
  { label: 'status-matrix', re: /生产态（\s*`([0-9a-f]{7,40})`\s*）/gi },
  { label: 'v0b-build', re: /V0-B[^\n]*?`([0-9a-f]{7,40})`/gi },
];

/** Phrases that are only true before the first manual deployment. */
const STALE_DEPLOY_PHRASES = [
  { re: /部署未做/, label: 'deployment-not-done-claim' },
  { re: /Vercel 100\/day/, label: 'vercel-quota-claim' },
];

/** Extract claimed production commits from a markdown document. */
export function parseStatusDoc(text) {
  const refs = [];
  for (const { label, re } of REF_PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(String(text ?? ''))) !== null) {
      refs.push({ label, commit: match[1].toLowerCase() });
    }
  }
  return refs;
}

/** Pure drift check. Commits compare by prefix (7+ chars), case-insensitive. */
export function checkStatusDrift({
  deploymentLog, documents = [], expectedCommit = null,
  healthzCommit = null, expectedTestTotal = null,
} = {}) {
  const parsed = parseDeploymentLog(deploymentLog);
  const expected = String(expectedCommit ?? parsed.latest ?? '').toLowerCase();
  const violations = [];
  if (!expected) violations.push({ kind: 'missing-expectation', detail: 'no READY deployment row found' });
  const refs = [];
  for (const document of documents) {
    const found = parseStatusDoc(document.text);
    for (const ref of found) {
      refs.push({ file: document.path, ...ref });
      if (!expected) continue;
      const aligned = ref.commit.startsWith(expected) || expected.startsWith(ref.commit);
      if (!aligned) {
        violations.push({
          kind: 'stale-build-reference',
          file: document.path,
          label: ref.label,
          claimed: ref.commit,
          expected,
        });
      }
    }
    // These phrases were true only before the first production deployment.
    if (document.path.endsWith('EVALUATION.md')) {
      for (const phrase of STALE_DEPLOY_PHRASES) {
        if (phrase.re.test(document.text)) {
          violations.push({ kind: 'stale-deployment-narrative', file: document.path, label: phrase.label, expected });
        }
      }
    }
    if (expectedTestTotal !== null) {
      const match = /当前基线：`?(\d+)\s*tests/i.exec(document.text);
      if (match && Number(match[1]) !== Number(expectedTestTotal)) {
        violations.push({
          kind: 'test-baseline-drift',
          file: document.path,
          claimed: Number(match[1]),
          expected: Number(expectedTestTotal),
        });
      }
    }
  }
  if (healthzCommit) {
    const live = String(healthzCommit).toLowerCase();
    if (expected && !(live.startsWith(expected) || expected.startsWith(live))) {
      violations.push({ kind: 'healthz-build-mismatch', claimed: live, expected });
    }
  }
  if (!violations.length && refs.length === 0) {
    violations.push({ kind: 'no-build-references', detail: 'documents contain no production commit references to check' });
  }
  return { ok: violations.length === 0, expected, latestDeployment: parsed.latest, references: refs, violations };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { stdout = console.log, stderr = console.error, readFileImpl = readFile } = deps;
  const arg = (name, fallback = '') => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const deploymentsPath = arg('--deployments', 'docs/DEPLOYMENTS.md');
  const documentPaths = argv.includes('--documents')
    ? argv.slice(argv.indexOf('--documents') + 1).filter((item) => !item.startsWith('--'))
    : ['AGENTS.md', 'docs/STATUS.md', 'docs/ACCEPTANCE.md', 'docs/EVALUATION.md'];
  if (!documentPaths.length) {
    stderr('usage: check-status-drift.mjs [--deployments file] [--documents file ...] [--expected commit] [--healthz-commit commit|--healthz-url url] [--test-total n] [--json]');
    return 2;
  }
  let deploymentLog;
  const documents = [];
  try {
    deploymentLog = await readFileImpl(deploymentsPath, 'utf8');
    for (const path of documentPaths) {
      documents.push({ path, text: await readFileImpl(path, 'utf8') });
    }
  } catch (error) {
    stderr(`[status-drift] cannot read files: ${error.message}`);
    return 2;
  }
  let healthzCommit = arg('--healthz-commit') || null;
  const healthzUrl = arg('--healthz-url');
  if (!healthzCommit && healthzUrl) {
    try {
      const response = await fetch(healthzUrl, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      healthzCommit = typeof body?.commit === 'string' ? body.commit : null;
    } catch (error) {
      stderr(`[status-drift] cannot fetch healthz: ${error.message}`);
      return 2;
    }
  }
  const testTotalArg = arg('--test-total');
  const result = checkStatusDrift({
    deploymentLog,
    documents,
    expectedCommit: arg('--expected') || null,
    healthzCommit,
    expectedTestTotal: testTotalArg ? Number(testTotalArg) : null,
  });
  if (argv.includes('--json')) {
    stdout(JSON.stringify(result, null, 2));
  } else {
    stdout(`[status-drift] expected=${result.expected || 'unknown'} latestDeployment=${result.latestDeployment || 'unknown'} refs=${result.references.length} violations=${result.violations.length}`);
    for (const violation of result.violations) {
      stdout(`[status-drift] VIOLATION ${violation.kind} ${violation.file ?? ''} ${violation.label ?? ''} claimed=${violation.claimed ?? ''} expected=${violation.expected ?? ''}`);
    }
  }
  return result.ok ? 0 : 1;
}

const isDirectRun = typeof process.argv[1] === 'string' && /check-status-drift\.mjs$/.test(process.argv[1]);
if (isDirectRun) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[status-drift] ${error?.message ?? String(error)}`);
    process.exitCode = 2;
  });
}
