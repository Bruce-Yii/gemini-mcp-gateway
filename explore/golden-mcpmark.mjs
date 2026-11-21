/**
 * golden-mcpmark.mjs —— MCPMark 权威金标映射（纯本地，无模型、无上游）
 *
 * 设计原则（务必先读 explore/README.md 的「MCPMark 金标」小节）：
 *
 * 1. MCPMark 的每个任务由 meta.json + description.md + verify.py 三件套组成。
 *    `description.md` 是喂给模型的完整用户口吻 prompt —— 这部分可以作为
 *    **权威 prompt 来源**，替换 / 补充 explore/tasks-final.json 里的 derived 任务。
 * 2. `verify.py` 是**终态检查**：它直接用 requests / notion_client 访问 MCPMark
 *    自己搭建并预置好的评测环境（例如 mcpmark-source/claude-code 的 #49/#51、
 *    特定 Notion 模板页面的 block 结构），靠 `MCP_GITHUB_TOKEN` / `GITHUB_EVAL_ORG`
 *    等环境变量定位到一个临时的 eval org / eval hub。我们的网关账号没有这些
 *    被预置的仓库和页面，也不在本工具里连上游，所以 **verify.py 跑不通**。
 * 3. 因此本工具**不产出 pass/fail 金标打分**，只产出：
 *    - 权威 prompt 清单（description.md 原文）；
 *    - derived 任务 → 权威 prompt 的候选映射（工作流级语义相近，不是逐工具 gold）；
 *    - 一个明确的「verifier 不可运行 / 只能做 prompt 权威性」判定。
 *
 * 安全边界：只读本地文件；不 fetch、不起子进程、不读凭据、不写文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

/** 默认本地 MCPMark 克隆根目录（被 gitignore，可能缺失） */
export const DEFAULT_MCPMARK_ROOT = path.join(PROJECT_ROOT, 'work', 'mcpmark');
/** 默认我方 derived 任务集 */
export const DEFAULT_TASKS_FILE = path.join(PROJECT_ROOT, 'explore', 'tasks-final.json');
/** MCPMark 覆盖我方四个服务中的两个 */
export const SUPPORTED_SERVICES = ['github', 'notion'];
export const DEFAULT_SUITES = ['standard', 'easy'];

/**
 * derived 工具 → MCPMark 任务标签话题（用于候选匹配）。
 * 这是「工作流级语义相近」的关键词桥接，不是 gold label，也不是逐工具等价。
 */
export const TOOL_TOPICS = {
  // GitHub：issue / 评论 / 标签
  add_comment_to_pending_review: ['pr workflows', 'workflow automation'],
  add_reply_to_pull_request_comment: ['pr workflows'],
  update_issue_comment: ['issue management', 'workflow automation'],
  sub_issue_write: ['issue management'],
  list_issue_fields: ['issue management'],
  list_issue_types: ['issue management'],
  request_copilot_review: ['pr workflows'],
  search_issues: ['issue management', 'repository analysis'],
  get_label: ['issue management', 'label automation'],
  // GitHub：PR / 分支 / 提交 / 发布
  update_pull_request: ['pr workflows', 'workflow automation'],
  list_branches: ['repository analysis', 'pr workflows'],
  list_commits: ['repository analysis', 'commit analysis', 'git history'],
  list_tags: ['repository analysis', 'git history', 'release coordination'],
  get_tag: ['repository analysis', 'git history'],
  delete_file: ['repository analysis', 'file tracking', 'git history'],
  fork_repository: ['repository analysis'],
  get_latest_release: ['release coordination'],
  get_release_by_tag: ['release coordination'],
  list_releases: ['release coordination'],
  // Notion：侧边栏 / 收藏 / 日历 / 数据库
  'notion-get-sidebar-tabs': ['content organization', 'visual formatting'],
  'notion-update-sidebar-tabs': ['content organization', 'visual formatting'],
  'notion-update-page-favorites': ['content organization', 'visual formatting'],
  'notion-link-meeting-note-to-calendar-event': ['cross-reference linking', 'template population'],
  'notion-convert-to-meetings-database': ['database manipulation', 'template population'],
};

/**
 * 权威 benchmark 钉住的 server 版本不含这些较新/特有工具，只能做工作流级语义替换。
 * 结论来自 work/authoritative-sources.md 第 4.2 节（基于本地 MCPMark 任务实测）。
 */
export const EQUIVALENCE_NOTES = {
  add_comment_to_pending_review: '权威 benchmark 钉住的 GitHub MCP v0.15.0 不含该工具，只能工作流级语义替换',
  add_reply_to_pull_request_comment: '权威 benchmark 钉住的 GitHub MCP v0.15.0 不含该工具，只能工作流级语义替换',
  sub_issue_write: '权威 benchmark 钉住的 GitHub MCP v0.15.0 不含该工具，只能工作流级语义替换',
  list_issue_fields: '权威 benchmark 钉住的 GitHub MCP v0.15.0 不含该工具，只能工作流级语义替换',
  list_issue_types: '权威 benchmark 钉住的 GitHub MCP v0.15.0 不含该工具，只能工作流级语义替换',
  request_copilot_review: '权威 benchmark 钉住的 GitHub MCP v0.15.0 不含该工具，只能工作流级语义替换',
  'notion-get-sidebar-tabs': '新版 Notion MCP 工具；MCPMark 钉 @1.9.1，无同名任务',
  'notion-update-sidebar-tabs': '新版 Notion MCP 工具；MCPMark 钉 @1.9.1，无同名任务',
  'notion-update-page-favorites': '新版 Notion MCP 工具；MCPMark 钉 @1.9.1，无同名任务',
  'notion-link-meeting-note-to-calendar-event': '新版 Notion MCP 工具；MCPMark 钉 @1.9.1，无同名任务',
  delete_file: '相邻操作（文件写入/追踪），非删除动作的等价任务',
  get_latest_release: '相邻操作（发布工作流），非逐工具等价',
  get_release_by_tag: '相邻操作（发布工作流），非逐工具等价',
  list_releases: '相邻操作（发布工作流），非逐工具等价',
  get_label: '相邻操作（标签自动化），非逐工具等价',
  'notion-convert-to-meetings-database': '语义相近的 database 操作，非同名工具',
};

const DEFAULT_NOTE = '工作流级语义相近的权威 prompt 候选；非逐工具 gold，也不可自动打分';

function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function sortDirectories(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * 扫描本地 MCPMark 克隆，返回权威任务清单。
 * 不存在的克隆不会被自动拉取（本模块永不连上游），而是如实标记 sourcePresent:false。
 */
export function discoverAuthoritativeTasks(options = {}) {
  const root = options.root || DEFAULT_MCPMARK_ROOT;
  const suites = (options.suites || DEFAULT_SUITES).slice().sort();
  const services = options.services || SUPPORTED_SERVICES;
  const sourcePresent = fs.existsSync(root) && fs.statSync(root).isDirectory();
  const tasks = [];
  if (!sourcePresent) return { sourcePresent: false, root, tasks };

  for (const service of services) {
    for (const suite of suites) {
      const suiteRoot = path.join(root, 'tasks', service, suite);
      for (const category of sortDirectories(suiteRoot)) {
        const categoryRoot = path.join(suiteRoot, category);
        for (const taskId of sortDirectories(categoryRoot)) {
          const dir = path.join(categoryRoot, taskId);
          const metaFile = path.join(dir, 'meta.json');
          const descFile = path.join(dir, 'description.md');
          const verifyFile = path.join(dir, 'verify.py');
          const metaText = readTextIfExists(metaFile);
          const prompt = readTextIfExists(descFile);
          if (!metaText || prompt == null) continue; // 三件套不完整的不算权威任务
          let meta = {};
          try {
            meta = JSON.parse(metaText);
          } catch {
            continue;
          }
          const key = `${service}/${suite}/${category}/${taskId}`;
          tasks.push({
            key,
            service,
            suite,
            category,
            taskId,
            name: meta.task_name || taskId,
            summary: meta.description || '',
            author: meta.author || null,
            difficulty: meta.difficulty || null,
            tags: Array.isArray(meta.tags) ? meta.tags.slice() : [],
            stateType: meta.meta_data?.stateType ?? null,
            stateUrl: meta.meta_data?.stateUrl ?? null,
            stateOriginalUrl: meta.meta_data?.stateOriginalUrl ?? null,
            // description.md 原文 = 权威 prompt（喂给模型的完整指令）
            prompt: prompt.trim(),
            files: {
              meta: metaFile,
              description: descFile,
              verify: fs.existsSync(verifyFile) ? verifyFile : null,
            },
          });
        }
      }
    }
  }
  tasks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { sourcePresent: true, root, tasks };
}

/**
 * 静态判定 verify.py 的可运行性。只读源码文本，绝不执行 verify.py。
 *
 * 结论固定为 runnableAgainstOurAccount:false：verifier 面向 MCPMark 自己预置的
 * 临时评测环境（eval org / eval hub），我们的账号没有那套环境，且本工具不连上游。
 * markers / evidence 用于解释「为什么跑不通」，不是运行尝试。
 */
export function classifyVerifier(task) {
  if (typeof task === 'string') {
    return classifyVerifier({ files: { verify: null }, _verifySource: task, stateUrl: null, stateType: null });
  }
  const source = task._verifySource ?? (task.files?.verify ? readTextIfExists(task.files.verify) : null);
  if (source == null) {
    return {
      runnableAgainstOurAccount: false,
      requiresExternalState: false,
      markers: [],
      evidence: ['缺少 verify.py，无终态检查可执行'],
      reason: '无 verify.py，无法做终态验证；只能引用 description.md 作为 prompt 来源',
    };
  }

  const checks = [
    [/api\.github\.com/, 'api.github.com', 'verify.py 直接用 requests 访问 api.github.com（绕开我方网关，查的是评测仓库终态）'],
    [/MCP_GITHUB_TOKEN|GITHUB_EVAL_ORG/, 'MCP_GITHUB_TOKEN/GITHUB_EVAL_ORG', 'verify.py 依赖 MCP_GITHUB_TOKEN / GITHUB_EVAL_ORG 指向 MCPMark 的临时 eval org'],
    [/notion_client|notion_utils/, 'notion_client/notion_utils', 'verify.py 用 notion_client / notion_utils 读固定评测页面的 block 结构'],
    [/NOTION_|NOTION_TOKEN/, 'NOTION_*', 'verify.py 依赖 Notion 评测账号环境变量'],
    [/load_dotenv|os\.environ/, 'load_dotenv/os.environ', 'verify.py 从 .mcp_env / 环境变量取评测专用凭据'],
    [/requests\.|Client\(/, 'requests/Client', 'verify.py 直接连上游 API 做终态断言，不是模型回答文本匹配'],
  ];
  const markers = [];
  const evidence = [];
  for (const [re, label, text] of checks) {
    if (re.test(source)) {
      markers.push(label);
      evidence.push(text);
    }
  }
  if (task.stateUrl) {
    evidence.push(`meta.json 绑定固定评测环境 ${task.stateUrl}（我方账号未预置该仓库/页面）`);
  }

  return {
    runnableAgainstOurAccount: false,
    requiresExternalState: markers.length > 0 || Boolean(task.stateUrl),
    markers,
    evidence,
    reason:
      'MCPMark verify.py 是终态检查：它验证 MCPMark 预置的临时仓库/页面（如 issue #49/#51、特定 block 结构），' +
      '需要 eval org/eval hub 与专用凭据。我们的账号没有这套被预置的环境，且本工具不连上游、不执行 Python，' +
      '因此 verifier 不能用来给我方任务自动打分；只能取 description.md 做权威 prompt。',
  };
}

/** 读取 tasks-final.json 中全部 official:false 的派生任务 */
export function loadDerivedTasks(options = {}) {
  const file = options.file || DEFAULT_TASKS_FILE;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  return tasks.filter((task) => task.official === false).map((task) => ({
    id: task.id,
    server: task.server,
    tool: task.tool,
    prompt: task.prompt,
    source: task.source ?? null,
    category: task.category ?? null,
  }));
}

/**
 * 把 derived 任务映射到 MCPMark 权威 prompt 候选。
 * - 服务门禁：Linear / Vercel 在 MCPMark 中 0 覆盖 → no_authoritative_source。
 * - 同服务下按 TOOL_TOPICS 与 MCPMark tags 交集打分，取 top 3。
 * - 所有命中一律标记 matchKind:'topic-only'：是候选 prompt，不是 gold 打分依据。
 */
export function mapDerivedToAuthoritative(derived, authoritativeTasks) {
  const byService = new Map();
  for (const task of authoritativeTasks) {
    if (!byService.has(task.service)) byService.set(task.service, []);
    byService.get(task.service).push(task);
  }

  return derived.map((task) => {
    const base = { id: task.id, server: task.server, tool: task.tool, prompt: task.prompt };
    if (!SUPPORTED_SERVICES.includes(task.server)) {
      return {
        ...base,
        status: 'no_authoritative_source',
        matches: [],
        note: 'MCPMark 无该服务任务集（权威源仅覆盖 GitHub / Notion）',
        recommendation: 'keep_derived_no_authoritative_source',
      };
    }
    const topics = TOOL_TOPICS[task.tool] || [];
    if (topics.length === 0) {
      return {
        ...base,
        status: 'no_authoritative_topic_match',
        matches: [],
        note: '未定义该工具到 MCPMark 话题的桥接，未强行编造映射',
        recommendation: 'keep_derived_manual_review',
      };
    }
    const topicSet = new Set(topics);
    const candidates = (byService.get(task.server) || [])
      .map((candidate) => ({
        candidate,
        score: candidate.tags.filter((tag) => topicSet.has(tag)).length,
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || (a.candidate.key < b.candidate.key ? -1 : a.candidate.key > b.candidate.key ? 1 : 0))
      .slice(0, 3)
      .map(({ candidate, score }) => ({
        key: candidate.key,
        suite: candidate.suite,
        category: candidate.category,
        taskId: candidate.taskId,
        name: candidate.name,
        score,
        matchKind: 'topic-only',
        stateUrl: candidate.stateUrl,
        // 权威 prompt 原文，供替换 / 补充 derived prompt
        prompt: candidate.prompt,
      }));

    if (candidates.length === 0) {
      return {
        ...base,
        status: 'no_authoritative_topic_match',
        matches: [],
        note: 'MCPMark 同服务任务中没有话题交集，未强行编造映射',
        recommendation: 'keep_derived_manual_review',
      };
    }
    return {
      ...base,
      status: 'authoritative_prompt_candidate',
      matches: candidates,
      note: EQUIVALENCE_NOTES[task.tool] || DEFAULT_NOTE,
      recommendation: 'use_mcpmark_description_as_authoritative_prompt',
    };
  });
}

/**
 * 汇总总报告：权威清单 + verifier 判定 + derived 映射 + 诚实结论。
 * 无时间戳，结果确定可测；不写文件，调用方决定如何消费。
 */
export function buildGoldenReport(options = {}) {
  const { sourcePresent, root, tasks: authoritative } = discoverAuthoritativeTasks(options);
  const derived = loadDerivedTasks(options);
  const mapping = mapDerivedToAuthoritative(derived, authoritative);

  const byService = {};
  const bySuite = {};
  for (const task of authoritative) {
    byService[task.service] = (byService[task.service] || 0) + 1;
    bySuite[task.suite] = (bySuite[task.suite] || 0) + 1;
  }
  const statusCounts = {};
  const derivedByService = {};
  for (const record of mapping) {
    statusCounts[record.status] = (statusCounts[record.status] || 0) + 1;
    derivedByService[record.server] = (derivedByService[record.server] || 0) + 1;
  }
  const verifierSamples = authoritative.length
    ? [classifyVerifier(authoritative.find((t) => t.service === 'github') || authoritative[0]),
       classifyVerifier(authoritative.find((t) => t.service === 'notion') || authoritative[0])]
    : [];

  const promptCandidates = statusCounts.authoritative_prompt_candidate || 0;
  const noSource = statusCounts.no_authoritative_source || 0;

  return {
    schemaVersion: 1,
    source: {
      present: sourcePresent,
      root,
      authoritativeCount: authoritative.length,
      byService,
      bySuite,
    },
    verifier: {
      runnableAgainstOurAccount: false,
      goldScoringAvailable: false,
      tasksWithVerifier: authoritative.filter((t) => t.files.verify).length,
      samples: verifierSamples,
      reason: verifierSamples[0]?.reason ||
        '本地 MCPMark 克隆缺失，无法读取 verify.py；即使存在，其终态检查也依赖 MCPMark 自有评测环境，不能对我方账号打分',
    },
    mapping: {
      derivedTotal: derived.length,
      derivedByService,
      statusCounts,
      withAuthoritativePromptCandidate: promptCandidates,
      withoutAuthoritativeSource: noSource,
      records: mapping,
    },
    conclusion: {
      promptAuthorityAvailable: authoritative.length > 0,
      goldScoringAvailable: false,
      summary: '只能做 prompt 权威性，不能自动打分',
      details:
        `MCPMark description.md 可作为权威 prompt 来源：${promptCandidates}/${derived.length} 条 derived 任务找到同服务话题级候选` +
        `（GitHub+Notion），${noSource} 条（Linear+Vercel）权威源 0 覆盖。` +
        '但所有候选仅代表工作流级语义相近，不是逐工具 gold；verify.py 依赖 MCPMark 预置的临时评测环境与专用凭据，' +
        '我方账号没有该环境且本工具不连上游，因此不产出 pass/fail 金标分数。',
    },
  };
}

/** CLI：node explore/golden-mcpmark.mjs → stdout 打印 JSON 报告（不写文件） */
export function main() {
  const report = buildGoldenReport();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
