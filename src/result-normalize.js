/**
 * B10 P0-1 · GitHub 高频返回值 canonical 归一化（adapter，非上游改写）。
 *
 * 纯函数、无网络、无新依赖。目标是把上游不同形状（JSON 文本、{text,resources}、
 * {content,sha,size,encoding}、{result:{...}}、数组 content 等）折叠成**字段集合
 * 恒定**的视图，便于模型稳定读取；原始值一律放在 `raw` 里，不丢信息。
 *
 * 设计约束：
 * - 每个导出函数都不抛错；即使传入 Proxy / getter 抛异常的宿主对象，也返回稳定形状。
 * - 无法识别的字段一律为 `null`（`truncated` 是布尔标记，恒为 boolean）。
 * - content 统一是 string 或 null，不会出现数组/对象。
 * - 不改变调用者的值：返回新对象，`raw` 保留传入引用（不深拷贝）。
 */

const TRUNCATED_MARKER = '--- TRUNCATED ---';

/** 安全读取一个属性：getter 抛错时视为不存在，不向外传播。 */
function get(obj, key) {
  try {
    if (obj === null || typeof obj !== 'object') return undefined;
    return obj[key];
  } catch (_) {
    return undefined;
  }
}

/** 从若干候选键里取第一个非 null/undefined 的值。 */
function pick(obj, keys) {
  for (const key of keys) {
    const value = get(obj, key);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** 是否为普通对象（数组不算；数组另做处理）。 */
function isObj(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 尽可能把上游"JSON 文本"解成对象；解不开就原样返回字符串。
 * 不抛错、不递归过深（只解一层，避免把普通文本误判成结果）。
 */
function parseJsonText(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 2_000_000) return null;
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return null;
  }
}

/**
 * 解包常见 envelope：{result:...} / {text,resources} / JSON 字符串 / MCP content 数组。
 * 返回 { value, sawString }，where value 已尽量是可读的对象或字符串。
 */
function unwrap(value) {
  let v = value;
  // 字符串 -> JSON 文本尝试解析（解析失败仍保留字符串）。
  if (typeof v === 'string') {
    const parsed = parseJsonText(v);
    if (parsed !== null) v = parsed;
    return { value: v, sawString: true };
  }
  // { result: ... } envelope（只剥一层，防止无限递归）。
  if (isObj(v)) {
    const inner = get(v, 'result');
    if (isObj(inner) || typeof inner === 'string') {
      // 只有当 result 内部确实像结果载荷时才剥；避免把 {result:'ok'} 误拆。
      const looksLikePayload =
        isObj(inner) &&
        ['content', 'text', 'resources', 'number', 'title', 'sha', 'html_url', 'url', 'state'].some(
          (k) => get(inner, k) !== undefined,
        );
      if (looksLikePayload || typeof inner === 'string') v = inner;
    }
  }
  // MCP content 数组：[{type:'text',text:'...'}] -> 合并文本。
  // 但如果含嵌套 resource 块，不能在此展平（否则会只留下下载提示），
  // 保留数组交给 contentArrayToString 选真正的正文。
  if (Array.isArray(v)) {
    const hasNestedResource = v.some((item) => isObj(item) && isObj(get(item, 'resource')));
    if (!hasNestedResource) {
      const texts = v
        .map((item) => (isObj(item) ? get(item, 'text') : item))
        .filter((t) => typeof t === 'string');
      if (texts.length) v = texts.join('\n');
    }
  }
  if (typeof v === 'string') {
    const parsed = parseJsonText(v);
    if (parsed !== null) v = parsed;
  }
  return { value: v, sawString: typeof v === 'string' };
}

/**
 * 识别"下载成功"提示文本（GitHub get_file_contents 常见），它不是文件正文。
 * 只做窄匹配，避免把真实正文里恰好提到 "downloaded" 的内容误杀。
 */
function isDownloadNotice(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length > 300) return false; // 正文不会这么短地被当提示
  return /^(successfully\s+)?(downloaded|fetched|retrieved)\b/i.test(t) || /\bSHA:\s*[0-9a-f]{7,}/i.test(t);
}

/** 从一个 content/resource 项里取出可能的正文字符串（含嵌套 resource.text）。 */
function extractBodyText(item) {
  if (typeof item === 'string') return item;
  if (!isObj(item)) return null;
  // 直接 text / content / data
  const direct = pick(item, ['text', 'content', 'data']);
  if (typeof direct === 'string') return direct;
  // MCP resource block: {type:'resource', resource:{uri, mimeType, text}}
  const resource = get(item, 'resource');
  if (isObj(resource)) {
    const nested = pick(resource, ['text', 'content', 'data']);
    if (typeof nested === 'string') return nested;
  }
  return null;
}

/**
 * 把 content 数组折叠成正文。真实 capture 里 GitHub 会同时返回
 * "successfully downloaded text file (SHA: ...)" 提示和真正的文件内容
 * （在 {type:'resource', resource:{text}} 里）。此时不能被提示冒充正文：
 * 排除下载提示后，选最长的候选作为正文。
 * 没有下载提示、没有嵌套 resource 时，保持原有的逐项合并行为。
 */
function contentArrayToString(array) {
  const items = array.map(extractBodyText).filter((t) => t !== null);
  if (!items.length) return null;
  const hasDownloadNotice = items.some(isDownloadNotice);
  const hasNestedResource = array.some(
    (item) => isObj(item) && isObj(get(item, 'resource')),
  );
  if (hasDownloadNotice || hasNestedResource) {
    const bodies = items.filter((t) => !isDownloadNotice(t));
    const pool = bodies.length ? bodies : items;
    return pool.reduce((best, t) => (t.length > best.length ? t : best), '');
  }
  return items.join('\n');
}

/** 把任意 content 漂移（字符串/数组/对象/resource 列表）折叠成字符串或 null。 */
function contentToString(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return contentArrayToString(value);
  if (isObj(value)) {
    const text = pick(value, ['text', 'content', 'data']);
    if (typeof text === 'string') return text;
  }
  return null;
}

/** 合并 resources[].text（去重，避免同一段文本重复进入上下文；顺序保持首次出现）。 */
function resourcesToText(resources) {
  if (!Array.isArray(resources)) return null;
  const seen = new Set();
  const parts = [];
  for (const resource of resources) {
    let text = null;
    if (typeof resource === 'string') text = resource;
    else if (isObj(resource)) {
      const candidate = pick(resource, ['text', 'content']);
      if (typeof candidate === 'string') text = candidate;
    }
    if (text !== null && !seen.has(text)) {
      seen.add(text);
      parts.push(text);
    }
  }
  return parts.length ? parts.join('\n') : null;
}

/**
 * P0 batch 11 · Explain *why* a file result is truncated.
 *
 * Historical code only recognized a top-level boolean or an in-band
 * `--- TRUNCATED ---` marker. Envelopes (`result.truncated`), string flags and
 * explicit `truncation` objects slipped through and made a shortened payload
 * look complete. This helper is the single source of truth for that decision;
 * `normalizeFileResult` keeps its stable field set and delegates to it.
 *
 * Returns a short reason string, or `null` when nothing signals truncation.
 * Pure and never throws (hostile Proxy getters are tolerated).
 */
export function explainTruncation(root, content) {
  // Convenience: a bare string is the content itself (used by direct callers
  // and by the string branch of normalizeFileResult).
  if (typeof root === 'string' && content === undefined) {
    content = root;
    root = null;
  }
  // A bare object with only `content` is another common direct-call shape.
  if (content === undefined && isObj(root)) {
    const candidate = pick(root, ['content', 'text', 'data']);
    if (typeof candidate === 'string') content = candidate;
  }
  const flagFrom = (obj) => {
    const raw = pick(obj, ['truncated', 'isTruncated', 'truncation']);
    if (raw === true) return 'upstream:truncated';
    if (raw === 1 || raw === '1') return 'upstream:truncated';
    if (raw === 'true') return 'upstream:truncated';
    if (typeof raw === 'string' && raw.trim() !== '') return `upstream:${raw.trim().slice(0, 160)}`;
    if (isObj(raw)) {
      const reason = pick(raw, ['reason', 'detail', 'message']);
      if (typeof reason === 'string' && reason.trim() !== '') return reason.trim().slice(0, 160);
      return 'upstream:truncation-object';
    }
    return null;
  };
  try {
    const direct = flagFrom(root);
    if (direct) return direct;
    const nested = get(root, 'result');
    if (isObj(nested)) {
      const inner = flagFrom(nested);
      if (inner) return inner;
    }
    const text = String(content ?? '');
    if (text.includes(TRUNCATED_MARKER)) return `in-band:${TRUNCATED_MARKER}`;
    return null;
  } catch (_) {
    return null;
  }
}

function isTruncated(value, content) {
  try {
    if (value === true) return true;
    return explainTruncation({ truncated: value }, content) !== null;
  } catch (_) {
    return false;
  }
}

/**
 * 归一化 GitHub 读文件类工具返回值。
 * @returns {{content:string|null, sha:string|null, size:number|null, encoding:string|null,
 *           path:string|null, truncated:boolean, raw:*}}
 */
export function normalizeFileResult(value) {
  try {
    const { value: v } = unwrap(value);
    if (typeof v === 'string') {
      return {
        content: v,
        sha: null,
        size: v.length,
        encoding: null,
        path: null,
        truncated: isTruncated(null, v),
        raw: value,
      };
    }
    const root = isObj(v) ? v : {};
    // content 优先取顶层；再尝试 resources[].text；最后尝试 result 里的同名键。
    let content = contentToString(pick(root, ['content', 'text', 'data']));
    const rootResources = resourcesToText(get(root, 'resources'));
    // GitHub sometimes returns {text: "successfully downloaded ...\n<body>",
    // resources:[{text: body}]}; prefer the resource body so the notice never
    // becomes the file content.
    if (rootResources && (isDownloadNotice(String(pick(root, ['text', 'content', 'data']) ?? '')) || /successfully downloaded/i.test(String(pick(root, ['text', 'content', 'data']) ?? '')))) {
      content = rootResources;
    }
    if (content === null) content = rootResources;
    if (content === null) {
      const nested = get(root, 'result');
      if (isObj(nested)) {
        content = contentToString(pick(nested, ['content', 'text', 'data']));
        const nestedResources = resourcesToText(get(nested, 'resources'));
        if (nestedResources && /successfully downloaded/i.test(String(pick(nested, ['text', 'content', 'data']) ?? ''))) content = nestedResources;
        if (content === null) content = nestedResources;
      }
    }

    const shaFromNotice = /SHA:\s*([0-9a-f]{7,})/i.exec(String(pick(root, ['text', 'content', 'data']) ?? ''))?.[1];
    const sha = pick(root, ['sha', 'sha256', 'content_sha', 'commit_sha']) ?? shaFromNotice;
    const path = pick(root, ['path', 'name', 'uri', 'file_path']);
    const encoding = pick(root, ['encoding']);
    const sizeRaw = pick(root, ['size', 'bytes']);
    const sizeNum = Number(sizeRaw);
    const size = sizeRaw !== undefined && Number.isFinite(sizeNum) ? sizeNum : null;

    return {
      content: content !== null && typeof content === 'string' ? content : null,
      sha: sha !== undefined && sha !== null ? String(sha) : null,
      size,
      encoding: encoding !== undefined && encoding !== null ? String(encoding) : null,
      path: path !== undefined && path !== null ? String(path) : null,
      // P0 batch 11: use the root (not just the top-level flag) so nested
      // `result.truncated`, string flags and explicit `truncation` objects are
      // never mistaken for a complete payload.
      truncated: explainTruncation(root, content) !== null,
      raw: value,
    };
  } catch (_) {
    // 极端宿主对象（抛 getter 的 Proxy）也不能破坏调用方。
    return {
      content: null,
      sha: null,
      size: null,
      encoding: null,
      path: null,
      truncated: false,
      raw: value,
    };
  }
}

/** 从 URL 里兜底提取 PR/Issue 编号。 */
function numberFromUrl(value) {
  try {
    const match = /\/pull\/(\d+)(?:\/|$|\?)|\/issues\/(\d+)(?:\/|$|\?)/.exec(String(value ?? ''));
    if (!match) return null;
    const raw = match[1] ?? match[2];
    return raw !== undefined ? Number(raw) : null;
  } catch (_) {
    return null;
  }
}

function toNumber(value) {
  try {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

/**
 * 归一化 GitHub PR 返回值。
 * @returns {{number:number|null, title:string|null, url:string|null, state:string|null,
 *           headSha:string|null, baseRef:string|null, mergeable:boolean|null,
 *           sha:string|null, id:string|null, raw:*}}
 */
export function normalizePrResult(value) {
  try {
    const { value: v } = unwrap(value);
    const root = isObj(v) ? v : {};
    const number = toNumber(pick(root, ['number', 'prNumber', 'pr_number', 'id']));
    const urlRaw = pick(root, ['html_url', 'url', 'web_url']);
    const url = urlRaw !== undefined && urlRaw !== null ? String(urlRaw) : null;
    const head = isObj(get(root, 'head')) ? get(root, 'head') : {};
    const base = isObj(get(root, 'base')) ? get(root, 'base') : {};
    const shaRaw = pick(root, ['sha', 'head_sha', 'headSha']) ?? pick(head, ['sha']);
    const baseRefRaw = pick(root, ['baseRef', 'base_ref']) ?? pick(base, ['ref']);
    const titleRaw = pick(root, ['title']);
    const stateRaw = pick(root, ['state']);
    const mergeableRaw = pick(root, ['mergeable', 'mergeable_state']);
    const idRaw = pick(root, ['id', 'node_id']);

    return {
      number: number ?? numberFromUrl(url),
      title: titleRaw !== undefined && titleRaw !== null ? String(titleRaw) : null,
      url,
      state: stateRaw !== undefined && stateRaw !== null ? String(stateRaw) : null,
      headSha: shaRaw !== undefined && shaRaw !== null ? String(shaRaw) : null,
      baseRef: baseRefRaw !== undefined && baseRefRaw !== null ? String(baseRefRaw) : null,
      mergeable:
        typeof mergeableRaw === 'boolean'
          ? mergeableRaw
          : mergeableRaw === 'mergeable'
            ? true
            : mergeableRaw !== undefined && mergeableRaw !== null
              ? false
              : null,
      sha: shaRaw !== undefined && shaRaw !== null ? String(shaRaw) : null,
      id: idRaw !== undefined && idRaw !== null ? String(idRaw) : null,
      raw: value,
    };
  } catch (_) {
    return {
      number: null,
      title: null,
      url: null,
      state: null,
      headSha: null,
      baseRef: null,
      mergeable: null,
      sha: null,
      id: null,
      raw: value,
    };
  }
}

/**
 * 归一化 GitHub Issue（或 PR-as-Issue）返回值。
 * @returns {{number:number|null, id:string|null, url:string|null, state:string|null,
 *           title:string|null, raw:*}}
 */
export function normalizeIssueResult(value) {
  try {
    const { value: v } = unwrap(value);
    const root = isObj(v) ? v : {};
    const number = toNumber(pick(root, ['number', 'issueNumber', 'issue_number', 'id']));
    const urlRaw = pick(root, ['html_url', 'url', 'web_url']);
    const url = urlRaw !== undefined && urlRaw !== null ? String(urlRaw) : null;
    const titleRaw = pick(root, ['title']);
    const stateRaw = pick(root, ['state']);
    const idRaw = pick(root, ['id', 'node_id']);

    return {
      number: number ?? numberFromUrl(url),
      id: idRaw !== undefined && idRaw !== null ? String(idRaw) : null,
      url,
      state: stateRaw !== undefined && stateRaw !== null ? String(stateRaw) : null,
      title: titleRaw !== undefined && titleRaw !== null ? String(titleRaw) : null,
      raw: value,
    };
  } catch (_) {
    return { number: null, id: null, url: null, state: null, title: null, raw: value };
  }
}

// --- 工具名分发 -------------------------------------------------------------

const FILE_TOOL_NAMES = new Set([
  'get_file_contents',
  'read_file',
  'get_file',
  'file_read',
  'get_content',
  'get_file_content',
  'github_get_file_contents',
  'gh_get_file_contents',
]);
const PR_TOOL_NAMES = new Set([
  'create_pull_request',
  'get_pull_request',
  'pull_request',
  'pulls_get',
  'pulls_create',
  'create_pr',
  'get_pr',
  'update_pull_request',
  'merge_pull_request',
  'github_create_pull_request',
  'gh_create_pull_request',
]);
const ISSUE_TOOL_NAMES = new Set([
  'get_issue',
  'create_issue',
  'issue',
  'issues_get',
  'issues_create',
  'update_issue',
  'list_issues',
  'github_get_issue',
  'gh_get_issue',
]);

/**
 * 按工具名分发归一化。工具名兼容 `server__tool` / `server.tool` / 纯 tool 形式
 * 以及大小写差异。未命中的工具：返回 `{raw: value}` 的明确 fallback，不猜测形状。
 */
export function normalizeResult(toolName, value) {
  let name;
  try {
    name = String(toolName ?? '').toLowerCase();
  } catch (_) {
    return { raw: value };
  }
  // 兼容 server__tool / server.tool / server-tool 形式：只剥前缀，保留 tool 内的下划线。
  const parts = name.split(/__(?=[^_])|[.](?=[^.])|-(?=[^-])/);
  const candidates = parts.length > 1 ? [parts[parts.length - 1], name] : [name];
  for (const candidate of candidates) {
    if (FILE_TOOL_NAMES.has(candidate)) return normalizeFileResult(value);
    if (PR_TOOL_NAMES.has(candidate)) return normalizePrResult(value);
    if (ISSUE_TOOL_NAMES.has(candidate)) return normalizeIssueResult(value);
  }
  return { raw: value };
}
