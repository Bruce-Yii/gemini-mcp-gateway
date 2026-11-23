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

/**
 * Batch 15 codemode ergonomics · security audit addendum.
 *
 * Canonical adapters intentionally retain the original upstream envelope in
 * `raw` for diagnostics. The raw value is UNTRUSTED model-external data: it
 * must be labelled explicitly so neither the model nor the capture audit can
 * mistake it for gateway-verified output. The marker is non-enumerable so the
 * historical stable field sets (FILE_KEYS / PR_KEYS / ISSUE_KEYS) stay intact.
 */
export const UNTRUSTED_RAW_MARKER = 'untrusted-upstream-envelope';
function markUntrustedRaw(result) {
  Object.defineProperty(result, 'rawUntrusted', {
    value: UNTRUSTED_RAW_MARKER, enumerable: false, configurable: true, writable: true,
  });
  return result;
}
/** Attach non-enumerable diagnostic metadata without changing stable key sets. */
function attachMeta(result, meta) {
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue;
    Object.defineProperty(result, key, {
      value, enumerable: false, configurable: true, writable: true,
    });
  }
  return result;
}

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
  // Narrow prefix match only: a real body that merely mentions "SHA:" or
  // "downloaded" is NOT a notice. The broad SHA-anywhere rule used to filter
  // out genuine file bodies and silently return empty content.
  // Short status lines from download/fetch helpers are notices too — but only
  // when they are standalone short lines, never a real body that mentions
  // "downloaded" or "SHA:" somewhere in the middle.
  return /^successfully downloaded text file \(SHA:/i.test(t)
    || /^(successfully\s+)?(downloaded|fetched|retrieved)\b[\s.,!]*$/i.test(t);
}

/**
 * Batch 15 P0 · the exact GitHub get_file_contents download notice line.
 * Narrow on purpose: a real file body that merely mentions "downloaded"
 * must never be treated as a notice. Returns {text, sha} where `text` is the
 * pure body (notice prefix removed) and `sha` is extracted from the notice.
 */
const FILE_DOWNLOAD_NOTICE = /^successfully downloaded text file \(SHA: ([0-9a-f]+)\)\r?\n/i;
// Notice with no trailing newline (notice-only payloads, or notice glued to a
// body by a different upstream version). Keep the narrow prefix, never search
// inside the body.
const FILE_DOWNLOAD_NOTICE_INLINE = /^successfully downloaded text file \(SHA: ([0-9a-f]+)(?:,[^)]*)?\)[ \t]*(?:\r?\n)?/i;

function stripDownloadNotice(text) {
  if (typeof text !== 'string') return { text, sha: null, notice: null };
  const match = FILE_DOWNLOAD_NOTICE.exec(text) || FILE_DOWNLOAD_NOTICE_INLINE.exec(text);
  return match
    ? { text: text.slice(match[0].length), sha: match[1], notice: match[0].trim() }
    : { text, sha: null, notice: null };
}

/**
 * Batch 15 P0 · content is ALWAYS pure body on every model-facing file result.
 * A download notice is metadata, never text. This helper is the single place
 * that decides what counts as a notice so no call site can reintroduce it.
 */
function pureFileText(value) {
  if (Array.isArray(value)) {
    // A content array may hide the notice in one of its text blocks. Collect
    // its metadata while folding the array into the pure body.
    const notices = [];
    const texts = [];
    for (const item of value) {
      const body = extractBodyText(item);
      if (body === null) continue;
      const s = stripDownloadNotice(body);
      if (typeof s.text === 'string' && s.text !== '') texts.push(s.text);
      if (s.notice) notices.push(s);
    }
    // With a notice present, multiple text blocks are alternative bodies —
    // joining them would prepend a short status/duplicate to the real body.
    // Pick the longest, matching contentArrayToString's rule.
    const text = notices.length && texts.length > 1
      ? texts.reduce((best, t) => (t.length > best.length ? t : best), '')
      : texts.join('\n');
    return {
      text,
      sha: notices.length ? notices[0].sha : null,
      notice: notices.length ? notices[0].notice : null,
    };
  }
  const stripped = stripDownloadNotice(value);
  return {
    text: stripped.text,
    sha: stripped.sha,
    notice: stripped.notice,
  };
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
    // Batch 15 P0: a notice is never content. Strip the prefix from any
    // candidate that carries one, then pick the longest remaining body.
    const bodies = items.map((t) => pureFileText(t).text).filter((t) => typeof t === 'string' && t !== '');
    const pool = bodies.length ? bodies : [];
    if (!pool.length) return '';
    return pool.reduce((best, t) => (t.length > best.length ? t : best), '');
  }
  return items.map((t) => pureFileText(t).text).join('\n');
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

/**
 * Batch 15 GPT online fix · parse a file path out of a GitHub MCP resource URI.
 *
 * The online raw shape was `repo://Bruce-Yii/<repo>/contents/<path>` and the
 * old code put that full URI into `path` via the generic `pick(...,['uri'])`,
 * or returned null when no explicit `path` key existed. We parse the well-known
 * `contents/` marker and return ONLY the path portion. Unknown URI schemes or
 * URIs without the marker yield null — never guess a path from arbitrary text.
 */
function pathFromUri(uri) {
  if (typeof uri !== 'string' || uri.length === 0) return null;
  const marker = '/contents/';
  const idx = uri.indexOf(marker);
  if (idx >= 0) {
    const path = uri.slice(idx + marker.length).split(/[?#]/)[0];
    return path.length > 0 ? decodeURIComponentSafe(path) : null;
  }
  // Also accept a bare `repo://owner/repo/.../<path>` without the marker only
  // when the URI has a decoded path segment after the repo host. This is kept
  // conservative: require at least two segments after `repo://`.
  if (/^repo:\/\//i.test(uri)) {
    const rest = uri.slice(7).split(/[?#]/)[0];
    const parts = rest.split('/').filter(Boolean);
    if (parts.length >= 3) return decodeURIComponentSafe(parts.slice(2).join('/'));
  }
  return null;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

/** Walk root and resources[] to find the first URI that yields a file path. */
function resolveFilePath(root, v) {
  const candidates = [];
  const take = (obj) => {
    if (!isObj(obj)) return;
    for (const key of ['path', 'file_path', 'filePath']) {
      const value = get(obj, key);
      if (typeof value === 'string' && value.length > 0) candidates.push({ value, fromUri: false });
    }
    const uri = pick(obj, ['uri']);
    if (typeof uri === 'string') candidates.push({ value: uri, fromUri: true });
  };
  take(root);
  const resources = get(root, 'resources');
  if (Array.isArray(resources)) {
    for (const r of resources) {
      take(r);
      const nested = isObj(r) ? get(r, 'resource') : null;
      if (isObj(nested)) take(nested);
    }
  }
  const content = get(root, 'content');
  if (Array.isArray(content)) {
    for (const item of content) {
      const nested = isObj(item) ? get(item, 'resource') : null;
      if (isObj(nested)) take(nested);
      else take(item);
    }
  }
  if (v !== root) take(v);
  for (const c of candidates) {
    if (!c.fromUri) return c.value;
    const parsed = pathFromUri(c.value);
    if (parsed !== null) return parsed;
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
      const stripped = pureFileText(v);
      return markUntrustedRaw(attachMeta({
        content: stripped.text,
        sha: stripped.sha,
        size: stripped.text.length,
        encoding: null,
        path: null,
        truncated: isTruncated(null, stripped.text),
        raw: value,
      }, { notice: stripped.notice, noticeSha: stripped.sha }));
    }
    const root = isObj(v) ? v : {};
    // content 优先取顶层；再尝试 resources[].text；最后尝试 result 里的同名键。
    const topText = pick(root, ['text', 'content', 'data']);
    const topStripped = pureFileText(topText);
    let content = contentToString(topStripped.text);
    const rootResources = resourcesToText(get(root, 'resources'));
    // GitHub sometimes returns {text: "successfully downloaded ...\n<body>",
    // resources:[{text: body}]}; prefer the resource body (already stripped)
    // so the notice never becomes the file content.
    if (rootResources && /successfully downloaded/i.test(String(topText ?? ''))) {
      content = pureFileText(rootResources).text;
    }
    if (content === null) content = rootResources === null ? null : pureFileText(rootResources).text;
    let nestedShaFromNotice = null;
    let nestedNotice = null;
    if (content === null) {
      const nested = get(root, 'result');
      if (isObj(nested)) {
        const nestedText = pick(nested, ['text', 'content', 'data']);
        const nestedStripped = pureFileText(nestedText);
        nestedShaFromNotice = nestedStripped.sha;
        nestedNotice = nestedStripped.notice;
        content = contentToString(nestedStripped.text);
        const nestedResources = resourcesToText(get(nested, 'resources'));
        if (nestedResources && /successfully downloaded/i.test(String(nestedText ?? ''))) {
          content = pureFileText(nestedResources).text;
        }
        if (content === null) content = nestedResources === null ? null : pureFileText(nestedResources).text;
      }
    }
    // Batch 15 P0: final belt-and-braces strip. Even a resource body that
    // starts with a download notice must not leak it into `content`.
    const finalStripped = pureFileText(content);
    content = finalStripped.text;

    const shaFromNotice = topStripped.sha
      ?? nestedShaFromNotice
      ?? finalStripped.sha
      ?? (/SHA:\s*([0-9a-f]{7,})/i.exec(String(topText ?? ''))?.[1] ?? null);
    const sha = pick(root, ['sha', 'sha256', 'content_sha', 'commit_sha']) ?? shaFromNotice;
    // Batch 15 GPT online fix: derive `path` from root/resources URIs. Never
    // return the raw `repo://.../contents/...` URI as a path; parse it, and
    // return null when no usable URI exists (don't guess).
    const path = resolveFilePath(root, v);
    const encoding = pick(root, ['encoding']);
    const sizeRaw = pick(root, ['size', 'bytes']);
    const sizeNum = Number(sizeRaw);
    const size = sizeRaw !== undefined && Number.isFinite(sizeNum) ? sizeNum : null;
    const notice = topStripped.notice ?? nestedNotice ?? finalStripped.notice;
    // P0 batch 11: use the root (not just the top-level flag) so nested
    // `result.truncated`, string flags and explicit `truncation` objects are
    // never mistaken for a complete payload.
    const truncated = explainTruncation(root, content) !== null;
    return markUntrustedRaw(attachMeta({
      content: content !== null && typeof content === 'string' ? content : null,
      sha: sha !== undefined && sha !== null ? String(sha) : null,
      size,
      encoding: encoding !== undefined && encoding !== null ? String(encoding) : null,
      path: path !== undefined && path !== null ? String(path) : null,
      truncated,
      raw: value,
    }, {
      notice,
      noticeSha: shaFromNotice,
      truncation: truncated ? explainTruncation(root, content) : null,
    }));
  } catch (_) {
    // 极端宿主对象（抛 getter 的 Proxy）也不能破坏调用方。
    return markUntrustedRaw({
      content: null,
      sha: null,
      size: null,
      encoding: null,
      path: null,
      truncated: false,
      raw: value,
    });
  }
}

/** 从 URL 里兜底提取 PR/Issue 编号。 */
function numberFromUrl(value) {
  try {
    const match = /\/pulls?\/(\d+)(?:\/|$|\?|#)|\/issues\/(\d+)(?:\/|$|\?|#)/.exec(String(value ?? ''));
    if (!match) return null;
    const raw = match[1] ?? match[2];
    return raw !== undefined ? Number(raw) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Batch 15 P0 · find the first PR/issue URL anywhere in a shape (root, result
 * envelope, list items or a nested pull_request link). URL is the ONLY source
 * of a user-visible number besides an explicit number field — database ids
 * (id / node_id) are NEVER considered.
 */
function findNumberUrl(root) {
  if (!isObj(root)) return null;
  const urls = [];
  const take = (obj) => {
    if (!isObj(obj)) return;
    for (const key of ['html_url', 'url', 'web_url', 'api_url']) {
      const value = get(obj, key);
      if (typeof value === 'string') urls.push(value);
    }
  };
  take(root);
  const nested = get(root, 'result');
  if (isObj(nested)) take(nested);
  const items = get(root, 'items');
  if (Array.isArray(items) && items.length) take(items[0]);
  const prLink = get(root, 'pull_request');
  if (isObj(prLink)) take(prLink);
  for (const url of urls) {
    const n = numberFromUrl(url);
    if (n !== null) return { url, number: n };
  }
  return null;
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
    // `id` is GitHub's internal database id, NOT the PR number. A real
    // create_pull_request returns {id:5444514334, url:'.../pull/53'}; treating
    // id as number made the subsequent merge call 404. Never fall back to id.
    const urlRaw = pick(root, ['html_url', 'url', 'web_url']);
    const url = urlRaw !== undefined && urlRaw !== null ? String(urlRaw) : null;
    // URL wins over explicit fields: it is the most reliable source of the
    // user-visible PR number when both are present but disagree. Search the
    // whole envelope (result/list items/pull_request link) so create/list/get/
    // merge shapes all agree. `id` is never a fallback.
    const found = findNumberUrl(root);
    const number = (found ? found.number : numberFromUrl(url))
      ?? toNumber(pick(root, ['number', 'prNumber', 'pr_number']));
    const head = isObj(get(root, 'head')) ? get(root, 'head') : {};
    const base = isObj(get(root, 'base')) ? get(root, 'base') : {};
    const shaRaw = pick(root, ['sha', 'head_sha', 'headSha']) ?? pick(head, ['sha']);
    const baseRefRaw = pick(root, ['baseRef', 'base_ref']) ?? pick(base, ['ref']);
    const titleRaw = pick(root, ['title']);
    const stateRaw = pick(root, ['state']);
    const mergeableRaw = pick(root, ['mergeable', 'mergeable_state']);
    // Keep `id` as the DB id when present; fall back to node_id only for this
    // legacy field so existing callers keep working. `nodeId` is the additive,
    // unambiguous GraphQL id exposed by the batch-15 GPT online fix.
    const idRaw = pick(root, ['id']) ?? pick(root, ['node_id']);
    const nodeIdRaw = pick(root, ['node_id', 'nodeId']);

    const result = {
      number,
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
      // DB id, always a string, never a number fallback.
      id: idRaw !== undefined && idRaw !== null ? String(idRaw) : null,
      raw: value,
    };
    // `nodeId` is additive but deliberately NON-ENUMERABLE: the stable field
    // set (PR_KEYS in existing tests / downstream consumers) must not change.
    // It is still readable as `result.nodeId` and JSON.stringify(... ) keeps
    // the original stable shape. Number remains URL-first; id/nodeId never
    // masquerade as a PR number.
    Object.defineProperty(result, 'nodeId', {
      value: nodeIdRaw !== undefined && nodeIdRaw !== null ? String(nodeIdRaw) : null,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    return markUntrustedRaw(result);
  } catch (_) {
    const result = {
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
    Object.defineProperty(result, 'nodeId', {
      value: null,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    return markUntrustedRaw(result);
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
    // Same rule as PRs: `id` is a database id, never an issue number.
    const urlRaw = pick(root, ['html_url', 'url', 'web_url']);
    const url = urlRaw !== undefined && urlRaw !== null ? String(urlRaw) : null;
    const found = findNumberUrl(root);
    const number = (found ? found.number : numberFromUrl(url))
      ?? toNumber(pick(root, ['number', 'issueNumber', 'issue_number']));
    const titleRaw = pick(root, ['title']);
    const stateRaw = pick(root, ['state']);
    const idRaw = pick(root, ['id', 'node_id']);

    return markUntrustedRaw({
      number,
      id: idRaw !== undefined && idRaw !== null ? String(idRaw) : null,
      url,
      state: stateRaw !== undefined && stateRaw !== null ? String(stateRaw) : null,
      title: titleRaw !== undefined && titleRaw !== null ? String(titleRaw) : null,
      raw: value,
    });
  } catch (_) {
    return markUntrustedRaw({ number: null, id: null, url: null, state: null, title: null, raw: value });
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
    return markUntrustedRaw({ raw: value });
  }
  // 兼容 server__tool / server.tool / server-tool 形式：只剥前缀，保留 tool 内的下划线。
  const parts = name.split(/__(?=[^_])|[.](?=[^.])|-(?=[^-])/);
  const candidates = parts.length > 1 ? [parts[parts.length - 1], name] : [name];
  for (const candidate of candidates) {
    if (FILE_TOOL_NAMES.has(candidate)) return normalizeFileResult(value);
    if (PR_TOOL_NAMES.has(candidate)) return normalizePrResult(value);
    if (ISSUE_TOOL_NAMES.has(candidate)) return normalizeIssueResult(value);
  }
  return markUntrustedRaw({ raw: value });
}
