#!/usr/bin/env node
/**
 * Validate docs/eval/BADCASES.md structure and linkage fields.
 *
 * New badcases must carry `关联 activeEvalId` and `回归测试/任务`; legacy rows
 * may use `—`. `--strict` rejects `—` in those two columns so a new entry
 * cannot be filed without a record/regression anchor.
 *
 * Usage:
 *   node scripts/check-badcases.mjs
 *   node scripts/check-badcases.mjs --strict --json
 */
import { readFile } from 'node:fs/promises';

export const REQUIRED_COLUMNS = [
  'ID', '客户端', '上游', '类别', '现象摘要', '来源原文', '发现构建',
  '跨客户端验证结果', '状态', '关联 activeEvalId', '回归测试/任务',
];
const CROSS_CLIENT_PREFIXES = ['通过', '退化', '未验证', '不适用'];

function cellsOf(line) {
  // Drop the two empty edge cells created by leading/trailing pipes.
  return line.split('|').slice(1, -1).map((cell) => cell.trim());
}

export function parseBadcaseTable(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.startsWith('|') && cellsOf(line).includes('ID') && cellsOf(line).includes('状态'));
  if (headerIndex === -1) return { header: [], rows: [] };
  const header = cellsOf(lines[headerIndex]);
  const rows = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith('|')) break;
    if (/^\|[\s:|-]+\|$/.test(line)) continue; // separator
    rows.push({ line: index + 1, cells: cellsOf(line), raw: line });
  }
  return { header, rows };
}

export function validateBadcases(text, { strict = false } = {}) {
  const { header, rows } = parseBadcaseTable(text);
  const errors = [];
  const warnings = [];
  if (!header.length) return { ok: false, errors: ['no badcase table header found'], warnings };
  for (const column of REQUIRED_COLUMNS) {
    if (!header.includes(column)) errors.push(`missing column: ${column}`);
  }
  const indexOf = (name) => header.indexOf(name);
  const seen = new Set();
  for (const row of rows) {
    if (row.cells.length !== header.length) {
      errors.push(`line ${row.line}: ${row.cells.length} cells, expected ${header.length}`);
      continue;
    }
    const id = (row.cells[indexOf('ID')] ?? '').replace(/\*/g, '');
    if (!/^BC-\d+$/.test(id)) errors.push(`line ${row.line}: invalid ID ${id}`);
    if (id && seen.has(id)) errors.push(`line ${row.line}: duplicate ID ${id}`);
    seen.add(id);
    const cross = (row.cells[indexOf('跨客户端验证结果')] ?? '').replace(/`/g, '');
    if (!CROSS_CLIENT_PREFIXES.some((prefix) => cross.startsWith(prefix))) {
      errors.push(`line ${row.line}: cross-client result must start with one of ${CROSS_CLIENT_PREFIXES.join('/')}`);
    }
    if (!(row.cells[indexOf('状态')] ?? '').trim()) errors.push(`line ${row.line}: empty status`);
    const active = (row.cells[indexOf('关联 activeEvalId')] ?? '').trim();
    const test = (row.cells[indexOf('回归测试/任务')] ?? '').trim();
    const sourceCell = row.cells[indexOf('来源原文')] ?? '';
    // Legacy rows predate the linkage columns and are exempt from --strict;
    // a NEW row (source cites an active-eval) must carry both links.
    const legacy = !/active-eval/i.test(sourceCell) && active === '—' && test === '—';
    if (!active || active === '—') {
      if (strict && !legacy) errors.push(`line ${row.line}: missing 关联 activeEvalId`);
      else warnings.push(`line ${row.line}: legacy row has no activeEvalId`);
    }
    if (!test || test === '—') {
      if (strict && !legacy) errors.push(`line ${row.line}: missing 回归测试/任务`);
      else warnings.push(`line ${row.line}: legacy row has no regression task`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, rows: rows.length };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { stdout = console.log, stderr = console.error, readFileImpl = readFile } = deps;
  const arg = (name, fallback = '') => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const file = arg('--file', 'docs/eval/BADCASES.md');
  let text;
  try {
    text = await readFileImpl(file, 'utf8');
  } catch (error) {
    stderr(`[badcases] cannot read ${file}: ${error.message}`);
    return 2;
  }
  const result = validateBadcases(text, { strict: argv.includes('--strict') });
  if (argv.includes('--json')) stdout(JSON.stringify(result, null, 2));
  else {
    stdout(`[badcases] rows=${result.rows} errors=${result.errors.length} warnings=${result.warnings.length} strict=${argv.includes('--strict')}`);
    for (const error of result.errors) stdout(`[badcases] ERROR ${error}`);
    for (const warning of result.warnings) stdout(`[badcases] WARN ${warning}`);
  }
  return result.ok ? 0 : 1;
}

const isDirectRun = typeof process.argv[1] === 'string' && /check-badcases\.mjs$/.test(process.argv[1]);
if (isDirectRun) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[badcases] ${error?.message ?? String(error)}`);
    process.exitCode = 2;
  });
}
