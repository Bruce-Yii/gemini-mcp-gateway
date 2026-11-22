/**
 * Read-only join between ONLINE capture windows and OFFLINE L1/G6 tasks.
 *
 * Batch 11 rules:
 *   - Map by windowId / sessionId only when an EXPLICIT taskId anchor exists.
 *   - A window without a taskId is `unmatched` (reason: no-online-taskId).
 *   - An online taskId with no corresponding offline task is `unmatched`
 *     (reason: no-offline-task).
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
 * Join online session/window rows to offline tasks by explicit taskId only.
 *
 * @param {object} args
 * @param {Array} args.windows  rows from digestSessions() (or envelopes with
 *                              windowId / sessionId / taskId fields)
 * @param {Array} args.tasks    offline L1/G6 task records (arrays or {tasks:[]})
 * @returns {{matched: Array, unmatched: Array, summary: object}}
 */
export function joinOnlineToOffline({ windows = [], tasks = [] } = {}) {
  const taskList = Array.isArray(tasks) ? tasks : (Array.isArray(tasks?.tasks) ? tasks.tasks : []);
  const offline = new Map();
  for (const task of taskList) {
    const id = taskIdOf(task);
    if (id && !offline.has(id)) offline.set(id, task);
  }

  const matched = [];
  const unmatched = [];
  const usedTaskIds = new Set();

  for (const window of windows) {
    const key = window?.windowId ?? window?.sessionId ?? null;
    const onlineTaskId = taskIdOf(window) ?? taskIdOf(window?.envelope ?? null);
    const base = {
      windowId: key,
      sessionId: window?.sessionId ?? null,
      onlineTaskId,
    };
    if (!onlineTaskId) {
      unmatched.push({ ...base, reason: 'no-online-taskId', offlineTask: null });
      continue;
    }
    const task = offline.get(onlineTaskId);
    if (!task) {
      unmatched.push({ ...base, reason: 'no-offline-task', offlineTask: null });
      continue;
    }
    usedTaskIds.add(onlineTaskId);
    matched.push({
      ...base,
      offlineTaskId: taskIdOf(task),
      // Keep originals so a reviewer can trace back to raw capture / task file.
      online: {
        windowId: key,
        sessionId: window?.sessionId ?? null,
        requestIdSamples: window?.requestIdSamples ?? [],
        requests: window?.requests ?? null,
      },
      offline: {
        taskId: taskIdOf(task),
        server: task?.server ?? null,
        tool: task?.tool ?? null,
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
    .map((task) => ({ taskId: taskIdOf(task), vendor: task?.server ?? null }));

  return {
    matched,
    unmatched,
    offlineOnly,
    summary: {
      windows: windows.length,
      matched: matched.length,
      unmatched: unmatched.length,
      offlineTasks: taskList.length,
      offlineOnly: offlineOnly.length,
      policy: 'explicit-taskId-only; no timestamp/prompt/tool guessing',
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
    policy: 'explicit-taskId-only; unmatched is not an error to paper over',
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
