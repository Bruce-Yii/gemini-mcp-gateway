#!/usr/bin/env node
/**
 * R2 distillation · stage 4 — the human/[云端总控] promotion gate
 * (see docs/eval/R2-DISTILLATION-DESIGN.md §二·阶段4).
 *
 * Candidates NEVER enter a gold suite automatically: this script enforces the
 * five hard quality standards and refuses to write anything when one is missing.
 *
 * Promote:
 *   node scripts/promote-eval-candidate.mjs --promote \
 *     --id CAND-20261125-a1b2c3d4 --to docs/eval/suites/adversarial-client-gold.json \
 *     --task-id AC-ADV-09 --prompt-file work/prompt.txt --claims-file work/claims.json
 *
 * Reject (noise blacklist):
 *   node scripts/promote-eval-candidate.mjs --reject --id CAND-... \
 *     --reason "OBS-001 已知协议协商"
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { redactAnalyzerText } from './analyze-captures.mjs';
import { DEFAULT_CANDIDATES_PATH, normalizePool } from './distill-r2-candidates.mjs';

export const SUITES_DIR = 'docs/eval/suites';
export const INDEX_PATH = join(SUITES_DIR, 'INDEX.json');
export const MIN_PROMPT_CHARS = 40;
export const MIN_CLAIMS = 3;
export const TASK_ID_RE = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$/;
const SUITE_FILE_RE = /-gold\.json$/;

const arr = (value) => (Array.isArray(value) ? value : []);
const str = (value) => (typeof value === 'string' ? value : '');
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function containsSecret(text) {
  const value = str(text);
  if (!value) return false;
  // redactSecrets replaces anything that looks like a credential; if the text
  // changes at all, it carried a secret shape and must be rejected.
  return redactAnalyzerText(value) !== value;
}

/**
 * The five hard standards (design §二·阶段4). Returns {ok, errors, task}.
 */
export function validatePromotion({ candidate, taskId, userPrompt, verifiableClaims, efficiencyBaseline }) {
  const errors = [];
  const prompt = str(userPrompt);
  if (!prompt.trim()) errors.push('userPrompt 为空');
  else if (prompt.trim().length < MIN_PROMPT_CHARS) {
    errors.push(`userPrompt 长度 ${prompt.trim().length} < ${MIN_PROMPT_CHARS}`);
  } else if (containsSecret(prompt)) {
    errors.push('userPrompt 含明文密钥形态');
  }

  const trap = str(candidate?.draftTask?.trap).trim();
  if (!trap || trap.startsWith('待人工精修')) errors.push('trap 为空或仍是占位文本（需人工精修后重试）');

  const claims = arr(verifiableClaims).map((claim) => str(claim).trim()).filter(Boolean);
  if (claims.length < MIN_CLAIMS) errors.push(`verifiableClaims ${claims.length} 条 < ${MIN_CLAIMS}`);

  if (!str(candidate?.candidateId).trim()) errors.push('candidateId 缺失，无法回填 referenceSource');
  if (!arr(candidate?.sampleRequestIds).filter(Boolean).length) {
    errors.push('candidate.sampleRequestIds 为空，referenceSource 无法回填证据');
  }

  const baseline = efficiencyBaseline ?? candidate?.draftTask?.efficiencyBaseline;
  const baselineKeys = ['maxSearchCalls', 'maxExecuteReadCalls', 'maxExecuteCalls'];
  const baselineValid = baseline && typeof baseline === 'object'
    && baselineKeys.every((key) => Number.isInteger(Number(baseline[key])) && Number(baseline[key]) >= 0);
  if (!baselineValid) errors.push('efficiencyBaseline 不完整或非整数（需 maxSearchCalls/maxExecuteReadCalls/maxExecuteCalls）');

  if (!TASK_ID_RE.test(str(taskId).trim())) errors.push(`task-id 格式非法：${str(taskId) || '(空)'}`);

  if (errors.length) return { ok: false, errors };

  const draft = candidate.draftTask ?? {};
  const referenceSource = [
    `candidate:${candidate.candidateId}`,
    `fingerprint:${candidate.fingerprint}`,
    `sampleRequestIds:${arr(candidate.sampleRequestIds).slice(0, 10).join(',')}`,
  ].join(' | ');

  return {
    ok: true,
    errors: [],
    task: {
      id: str(taskId).trim(),
      category: str(draft.category) || 'distilled',
      upstreams: [str(candidate.upstream) || 'gateway'],
      targetClients: arr(candidate.affectedClients).length ? arr(candidate.affectedClients) : ['all'],
      access: str(draft.access) === 'write' ? 'write' : 'read',
      tier: ['T0', 'T1', 'T2', 'T3'].includes(str(draft.tier)) ? str(draft.tier) : 'T2',
      referenceSource,
      failureModeTarget: arr(draft.failureModeTarget),
      trap,
      efficiencyBaseline: {
        maxSearchCalls: num(baseline.maxSearchCalls),
        maxExecuteReadCalls: num(baseline.maxExecuteReadCalls),
        maxExecuteCalls: num(baseline.maxExecuteCalls),
      },
      coverageThreshold: 0.8,
      userPrompt: prompt.trim(),
      verifiableClaims: claims,
    },
  };
}

/** Rebuild docs/eval/suites/INDEX.json from every *-gold.json suite. */
export async function rebuildIndex({ dir = SUITES_DIR, now = new Date() } = {}) {
  const files = (await readdir(dir)).filter((name) => SUITE_FILE_RE.test(name)).sort();
  const previous = await readJson(join(dir, 'INDEX.json'), null);
  const tierNames = previous?.tiers ?? {};
  const suites = [];
  const entries = [];
  const tiers = { T0: [], T1: [], T2: [], T3: [] };
  const byUpstream = {};
  const byClient = {};

  for (const file of files) {
    const suite = await readJson(join(dir, file), null);
    if (!suite) continue;
    const tasks = arr(suite.tasks);
    suites.push({ batch: str(suite.batch) || file, file, count: tasks.length });
    for (const task of tasks) {
      const tier = ['T0', 'T1', 'T2', 'T3'].includes(str(task.tier)) ? str(task.tier) : 'T2';
      tiers[tier].push(task.id);
      for (const upstream of arr(task.upstreams)) {
        byUpstream[upstream] = [...new Set([...(byUpstream[upstream] ?? []), task.id])];
      }
      for (const client of arr(task.targetClients)) {
        if (client === 'all') continue;
        byClient[client] = byClient[client] ?? { dedicatedProbes: [], recommendedT1: [] };
        byClient[client].dedicatedProbes = [...new Set([...byClient[client].dedicatedProbes, task.id])];
      }
      entries.push({
        id: task.id,
        file,
        batch: str(suite.batch) || file,
        tier,
        access: str(task.access) || 'read',
        upstreams: arr(task.upstreams),
        targetClients: arr(task.targetClients),
        rateLimitSensitive: task.rateLimitSensitive === true,
        failureModeTarget: arr(task.failureModeTarget),
      });
    }
  }

  const t1Ids = tiers.T1;
  for (const client of Object.keys(byClient)) byClient[client].recommendedT1 = [...t1Ids];
  const index = {
    schema: 'gold-eval-index.v1',
    version: str(previous?.version) || '1.0.0',
    updatedAt: now.toISOString(),
    maintainedBy: str(previous?.maintainedBy) || '[云端总控]',
    runnerProtocol: str(previous?.runnerProtocol) || 'docs/eval/suites/RUNNER.md',
    totalTasks: entries.length,
    suites,
    tiers: {
      T0: { name: str(tierNames?.T0?.name) || '极速烟测', taskIds: tiers.T0 },
      T1: { name: str(tierNames?.T1?.name) || '日常高频回归与防串伤', taskIds: tiers.T1 },
      T2: { name: str(tierNames?.T2?.name) || '单上游深水区', taskIds: tiers.T2 },
      T3: { name: str(tierNames?.T3?.name) || '全量权威大考', taskIds: tiers.T3 },
    },
    byClient,
    byUpstream,
    entries,
  };
  return index;
}

/** Promote one candidate into a gold suite, then refresh INDEX.json. */
export async function promoteCandidate({
  candidatesPath = DEFAULT_CANDIDATES_PATH,
  suitePath,
  candidateId,
  taskId,
  userPrompt,
  verifiableClaims,
  now = new Date(),
} = {}) {
  const pool = normalizePool(await readJson(candidatesPath, null), now);
  const candidate = pool.candidates.find((row) => row.candidateId === candidateId);
  if (!candidate) throw new Error(`PROMOTE_UNKNOWN_CANDIDATE: ${candidateId}`);
  if (candidate.status === 'rejected_noise') throw new Error(`PROMOTE_REJECTED_CANDIDATE: ${candidateId}`);
  if (candidate.status === 'promoted') throw new Error(`PROMOTE_ALREADY_PROMOTED: ${candidateId} -> ${candidate.promotedTaskId || '?'}`);

  const check = validatePromotion({ candidate, taskId, userPrompt, verifiableClaims });
  if (!check.ok) {
    const error = new Error(`PROMOTE_VALIDATION_FAILED:\n- ${check.errors.join('\n- ')}`);
    error.errors = check.errors;
    throw error;
  }

  const suite = await readJson(suitePath, null);
  if (!suite) throw new Error(`PROMOTE_SUITE_NOT_FOUND: ${suitePath}`);
  if (!Array.isArray(suite.tasks)) throw new Error(`PROMOTE_SUITE_INVALID: ${suitePath} has no tasks[]`);
  if (suite.tasks.some((task) => task.id === check.task.id)) {
    throw new Error(`PROMOTE_DUPLICATE_TASK_ID: ${check.task.id} already exists in ${suitePath}`);
  }

  suite.tasks.push(check.task);
  suite.updatedAt = now.toISOString();
  await writeJson(suitePath, suite);

  candidate.status = 'promoted';
  candidate.promotedTaskId = check.task.id;
  candidate.promotedAt = now.toISOString();
  pool.updatedAt = now.toISOString();
  await writeJson(candidatesPath, pool);

  const index = await rebuildIndex({ dir: dirname(suitePath), now });
  await writeJson(join(dirname(suitePath), 'INDEX.json'), index);
  return { task: check.task, candidateId, pool, index };
}

/** Reject one candidate as noise and blacklist its fingerprint. */
export async function rejectCandidate({ candidatesPath = DEFAULT_CANDIDATES_PATH, candidateId, reason, now = new Date() } = {}) {
  const pool = normalizePool(await readJson(candidatesPath, null), now);
  const candidate = pool.candidates.find((row) => row.candidateId === candidateId);
  if (!candidate) throw new Error(`REJECT_UNKNOWN_CANDIDATE: ${candidateId}`);
  const text = str(reason).trim();
  if (!text) throw new Error('REJECT_REASON_REQUIRED');
  candidate.status = 'rejected_noise';
  candidate.rejectedReason = text;
  candidate.rejectedAt = now.toISOString();
  pool.ignoredFingerprints = [...new Set([...pool.ignoredFingerprints, candidate.fingerprint])];
  pool.updatedAt = now.toISOString();
  await writeJson(candidatesPath, pool);
  return { candidateId, fingerprint: candidate.fingerprint, reason: text, pool };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { stdout = console.log, stderr = console.error } = deps;
  const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : '');
  const candidateId = arg('--id');
  const candidatesPath = arg('--candidates') || DEFAULT_CANDIDATES_PATH;
  const nowArg = arg('--now');
  const now = nowArg ? new Date(nowArg) : new Date();
  if (!candidateId) {
    stderr('usage: promote-eval-candidate.mjs --promote --id CAND-... --to <suite.json> --task-id <ID> --prompt-file <f> --claims-file <f> | --reject --id CAND-... --reason <text>');
    return 2;
  }
  try {
    if (argv.includes('--reject')) {
      const result = await rejectCandidate({ candidatesPath, candidateId, reason: arg('--reason'), now });
      if (argv.includes('--json')) stdout(JSON.stringify({ rejected: result.candidateId, fingerprint: result.fingerprint }, null, 2));
      else stdout(`[promote] rejected ${result.candidateId} (fingerprint ${result.fingerprint} blacklisted)`);
      return 0;
    }
    if (argv.includes('--promote')) {
      const suitePath = arg('--to');
      const taskId = arg('--task-id');
      const promptFile = arg('--prompt-file');
      const claimsFile = arg('--claims-file');
      if (!suitePath || !taskId || !promptFile || !claimsFile) {
        stderr('--promote requires --to <suite.json> --task-id <ID> --prompt-file <file> --claims-file <file>');
        return 2;
      }
      let userPrompt;
      let claims;
      try {
        userPrompt = await readFile(promptFile, 'utf8');
        claims = JSON.parse(await readFile(claimsFile, 'utf8'));
      } catch (error) {
        stderr(`[promote] cannot read inputs: ${error?.message ?? String(error)}`);
        return 2;
      }
      const result = await promoteCandidate({
        candidatesPath, suitePath, candidateId, taskId, userPrompt, verifiableClaims: claims, now,
      });
      if (argv.includes('--json')) {
        stdout(JSON.stringify({ promoted: candidateId, taskId: result.task.id, suite: suitePath, totalTasks: result.index.totalTasks }, null, 2));
      } else {
        stdout(`[promote] ${candidateId} -> ${result.task.id} in ${suitePath} (index totalTasks=${result.index.totalTasks})`);
      }
      return 0;
    }
    stderr('nothing to do: pass --promote or --reject');
    return 2;
  } catch (error) {
    stderr(`[promote] ${error?.message ?? String(error)}`);
    return 1;
  }
}

const isDirectRun = typeof process.argv[1] === 'string' && /promote-eval-candidate\.mjs$/.test(process.argv[1]);
if (isDirectRun) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[promote] ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });
}
