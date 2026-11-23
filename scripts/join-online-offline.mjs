/**
 * Read-only join between ONLINE capture windows and OFFLINE L1/G6 tasks.
 *
 * Batch 11 rules:
 *   - Map by explicit taskId first (unchanged behaviour).
 *   - Otherwise map by an EXPLICIT project key when both sides carry one
 *     (`projects[].key` / `primaryProject.key` online; `projectKey` / `repo`
 *     / `owner`+`repo` offline). Strict equality only.
 *   - A window without any anchor is `unmatched` (reason: no-online-taskId).
 *   - An anchor with no corresponding offline task is `unmatched`
 *     (reason: no-offline-task, with matchAttempt recorded).
 *   - Never guess a task from timestamps, tool names or prompts ("不要硬凑").
 *
 * The online windowId comes from `capture-digest.mjs` clustering (sessionId
 * first, otherwise deterministic initialize / 15-min idle windows). The taskId
 * is NOT synthesized by clustering: it must be stamped upstream on the
 * envelope (`taskId`, `request.taskId` or `meta.taskId`), or present on the
 * offline task record (`taskId` / `id`). Without it we do not map.
 *
 * Usage:
 *   # Pure function use (tests, other scripts):
 *   import { joinOnlineToOffline } from './join-online-offline.mjs';
 *
 *   # CLI (read-only, stdout JSON):
 *   node scripts/join-online-offline.mjs \
 *     --dir work/capture \
 *     --tasks explore/tasks-g6.json
 *   node scripts/join-online-offline.mjs \
 *     --since 2026-11-22 --days 1 \
 *     --tasks explore/baselines/l1-smoke.json
 *
 * No writes to R2, src/, or any repo file. Credentials from env only.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  listR2Keys, readR2Envelope, readDirEnvelopes, digestSessions,
} from './capture-digest.mjs';

/**
 * Extract an explicit taskId anchor. Never derived from timestamps / prompts.
 * Accepts the common envelope locations used by capture and offline tasks.
 */
export function taskIdOf(record) {
  if (!record || typeof record !== 'object') return null;
  const candidates = [
    record.taskId,
    record.meta?.taskId,
    record.request?.taskId,
    record.request?.headers?.['x-task-id'],
    record.request?.headers?.['X-Task-Id'],
    record.task?.taskId,
    record.task?.id,
    record.id, // offline task records use `id`
  ];
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && String(candidate) !== '') return String(candidate);
  }
  return null;
}

/**
 * Extract a project key anchor WITHOUT guessing. Accepts only explicit fields:
 *   - online windows: `projects[].key` / `primaryProject.key` from digestSessions
 *   - offline tasks: `projectKey`, `project`, `repo`, or `owner`+`repo`
 * The key shape is `github:<owner>/<repo>` (the same shape stamped by
 * `src/project-tag.js`). A plain `owner/repo` is normalised to that shape.
 * Prompts, tool names and timestamps are NEVER consulted.
 */
export function projectKeyOf(record) {
  if (!record || typeof record !== 'object') return null;
  const candidates = [
    record.projectKey,
    record.project?.key,
    record.primaryProject?.key,
    record.task?.projectKey,
    record.task?.project?.key,
  ];
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && String(candidate) !== '') {
      return String(candidate);
    }
  }
  // `repo` may be "owner/name" or just "name"; only "owner/name" is explicit.
  const repo = record.repo ?? record.project?.repo ?? record.task?.repo ?? null;
  const owner = record.owner ?? record.project?.owner ?? record.task?.owner ?? null;
  if (typeof repo === 'string' && repo.includes('/')) {
    const [o, r] = repo.trim().split('/');
    if (o && r) return `github:${o}/${r}`;
  }
  if (typeof owner === 'string' && typeof repo === 'string' && owner.trim() && repo.trim()) {
    return `github:${owner.trim()}/${repo.trim()}`;
  }
  return null;
}

/** All project keys attached to an online window (stable, deduped). */
export function projectKeysOfWindow(window) {
  const keys = [];
  const push = (value) => {
    const key = typeof value === 'string' ? value : projectKeyOf(value);
    if (key && !keys.includes(key)) keys.push(key);
  };
  push(window?.primaryProject);
  for (const project of (Array.isArray(window?.projects) ? window.projects : [])) push(project);
  // Bare string keys on the window itself are also explicit.
  if (Array.isArray(window?.projectKeys)) window.projectKeys.forEach(push);
  return keys;
}

/**
 * Join online session/window rows to offline tasks.
 *
 * Precedence:
 *   1. explicit taskId (existing behaviour, unchanged);
 *   2. explicit project key match (new): only when both sides carry an explicit
 *      project/repo field and the keys are strictly equal;
 *   3. otherwise unmatched — never inferred from timestamps, prompts or tools.
 *
 * @param {object} args
 * @param {Array} args.windows  rows from digestSessions() (or envelopes with
 *                              windowId / sessionId / taskId / projects fields)
 * @param {Array} args.tasks    offline L1/G6 task records (arrays or {tasks:[]})
 * @returns {{matched: Array, unmatched: Array, summary: object}}
 */
export function joinOnlineToOffline({ windows = [], tasks = [] } = {}) {
  const taskList = Array.isArray(tasks) ? tasks : (Array.isArray(tasks?.tasks) ? tasks.tasks : []);
  const offline = new Map();
  const offlineByProject = new Map();
  for (const task of taskList) {
    const id = taskIdOf(task);
    if (id && !offline.has(id)) offline.set(id, task);
    const projectKey = projectKeyOf(task);
    if (projectKey && !offlineByProject.has(projectKey)) offlineByProject.set(projectKey, task);
  }

  const matched = [];
  const unmatched = [];
  const usedTaskIds = new Set();

  for (const window of windows) {
    const key = window?.windowId ?? window?.sessionId ?? null;
    const onlineTaskId = taskIdOf(window) ?? taskIdOf(window?.envelope ?? null);
    const onlineProjectKeys = projectKeysOfWindow(window);
    const base = {
      windowId: key,
      sessionId: window?.sessionId ?? null,
      onlineTaskId,
      onlineProjectKeys,
    };

    // Precedence 1: explicit taskId anchor.
    let task = null;
    let matchBy = null;
    let onlineProjectKey = null;
    if (onlineTaskId) {
      task = offline.get(onlineTaskId) ?? null;
      if (task) matchBy = 'taskId';
      else {
        unmatched.push({ ...base, matchAttempt: 'taskId', reason: 'no-offline-task', offlineTask: null });
        continue;
      }
    } else if (onlineProjectKeys.length) {
      // Precedence 2: explicit project key. Strict equality only; no fuzzy match.
      matchBy = 'projectKey';
      onlineProjectKey = onlineProjectKeys.find((k) => offlineByProject.has(k)) ?? null;
      if (!onlineProjectKey) {
        unmatched.push({ ...base, matchAttempt: 'projectKey', reason: 'no-offline-task', offlineTask: null });
        continue;
      }
      task = offlineByProject.get(onlineProjectKey);
    } else {
      // No anchor at all: keep the historical reason string for compatibility.
      unmatched.push({ ...base, matchAttempt: null, reason: 'no-online-taskId', offlineTask: null });
      continue;
    }

    const offlineTaskId = taskIdOf(task);
    usedTaskIds.add(offlineTaskId);
    matched.push({
      ...base,
      matchBy,
      onlineProjectKey,
      offlineTaskId,
      // Keep originals so a reviewer can trace back to raw capture / task file.
      online: {
        windowId: key,
        sessionId: window?.sessionId ?? null,
        requestIdSamples: window?.requestIdSamples ?? [],
        requests: window?.requests ?? null,
        projects: window?.projects ?? [],
      },
      offline: {
        taskId: offlineTaskId,
        server: task?.server ?? null,
        tool: task?.tool ?? null,
        projectKey: projectKeyOf(task),
        // Never embed full prompts (may contain sensitive fixtures); keep short.
        promptSnippet: typeof task?.prompt === 'string' ? task.prompt.slice(0, 160) : null,
        source: task?.source ?? null,
      },
    });
  }

  // Offline tasks that never appeared online are reported separately — they are
  // NOT force-paired with any window (no hard-fitting).
  const offlineOnly = taskList
    .filter((task) => !usedTaskIds.has(taskIdOf(task)))
    .map((task) => ({ taskId: taskIdOf(task), projectKey: projectKeyOf(task), vendor: task?.server ?? null }));

  return {
    matched,
    unmatched,
    offlineOnly,
    summary: {
      windows: windows.length,
      matched: matched.length,
      matchedByTaskId: matched.filter((row) => row.matchBy === 'taskId').length,
      matchedByProjectKey: matched.filter((row) => row.matchBy === 'projectKey').length,
      unmatched: unmatched.length,
      offlineTasks: taskList.length,
      offlineOnly: offlineOnly.length,
      policy: 'explicit-taskId-only (first), then strict explicit projectKey; no timestamp/prompt/tool guessing',
    },
  };
}

/** CLI-only helper: attach taskId anchors from offline task records onto windows. */
export function attachTaskAnchors(windows, tasks) {
  const offline = new Map();
  for (const task of (Array.isArray(tasks) ? tasks : tasks?.tasks ?? [])) {
    const id = taskIdOf(task);
    if (id && !offline.has(id)) offline.set(id, task);
  }
  // The envelope itself is the source of truth. Historically, some runners
  // stamped only a sessionId; that is still NOT a taskId, so no mapping occurs
  // unless an explicit taskId exists on the online side.
  return windows.map((window) => ({
    ...window,
    taskId: taskIdOf(window) ?? taskIdOf(window?.envelope ?? null),
  }));
}

async function readTasks(file) {
  if (!file) return [];
  const raw = await readFile(resolve(file), 'utf8');
  return JSON.parse(raw);
}

async function loadEnvelopes({ dir, since, days, date }) {
  if (dir) return readDirEnvelopes(dir);
  if (since) {
    const start = new Date(`${since}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime())) throw new Error(`invalid --since date: ${since}`);
    const keys = [];
    for (let offset = 0; offset < days; offset += 1) {
      const day = new Date(start.getTime() + offset * 86400000).toISOString().slice(0, 10);
      keys.push(...await listR2Keys(`capture/${day}/`));
    }
    return Promise.all(keys.map(readR2Envelope));
  }
  const keys = await listR2Keys(`capture/${date ?? new Date().toISOString().slice(0, 10)}/`);
  return Promise.all(keys.map(readR2Envelope));
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
  const dir = arg('--dir');
  const since = arg('--since');
  const days = Number(arg('--days') || 1);
  const date = arg('--date');
  const tasksFile = arg('--tasks') || 'explore/tasks-g6.json';

  const envelopes = await loadEnvelopes({ dir, since, days, date });
  const windows = digestSessions(envelopes);
  const tasks = await readTasks(tasksFile);
  const anchored = attachTaskAnchors(windows, tasks);
  const result = joinOnlineToOffline({ windows: anchored, tasks });
  console.log(JSON.stringify({
    schema: 'online-offline-join.v1',
    advisoryOnly: true,
    requiresHumanReview: true,
    policy: 'explicit-taskId-only (first), then strict explicit projectKey; unmatched is not an error to paper over',
    inputs: { dir: dir || null, since: since || null, days, tasksFile, envelopes: envelopes.length },
    ...result,
  }, null, 2));
}

if (process.argv[1] && process.argv[1].endsWith('join-online-offline.mjs')) {
  main().catch((error) => {
    console.error(`[join] failed: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });
}
