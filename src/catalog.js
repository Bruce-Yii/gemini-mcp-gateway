/**
 * Catalog indexing and search for MCP tools.
 *
 * Deliberately dependency-free: tokenization + BM25-ish scoring. The gateway's
 * whole point is to keep the model-facing tool surface small, so search quality
 * has to be good enough with plain text matching and no embedding service.
 */

const CJK = /[\u3400-\u9fff]/;

/** Tokenize one text field into lowercase latin/number tokens plus CJK bigrams. */
export function tokenize(text) {
  if (typeof text !== 'string' || text === '') return [];
  const tokens = [];
  const lower = text.toLowerCase();
  for (const part of lower.split(/[^a-z0-9_\u3400-\u9fff]+/u)) {
    if (part === '') continue;
    if (!CJK.test(part)) {
      if (part.length >= 2) tokens.push(part);
      continue;
    }
    // CJK: unigrams and bigrams so "域名解析" matches "域名" / "解析".
    const chars = [...part];
    for (const ch of chars) tokens.push(ch);
    for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i] + chars[i + 1]);
  }
  return tokens;
}

/**
 * Tokenize an identifier-rich field (server / tool / name) into both whole
 * identifiers and their word parts. Natural-language queries ("create a
 * branch") can then match `create_branch` on the name itself instead of
 * piggybacking on a long, noisy description. `tokenize` is intentionally left
 * unchanged so its public contract stays intact.
 */
export function tokenizeIdentifier(text) {
  if (typeof text !== 'string' || text === '') return [];
  const tokens = [];
  const lower = text.toLowerCase();
  for (const part of lower.split(/[^a-z0-9_\u3400-\u9fff]+/u)) {
    if (part === '') continue;
    if (CJK.test(part)) {
      tokens.push(...tokenize(part));
      continue;
    }
    tokens.push(part); // whole identifier: keeps "select:server__tool" style queries working
    for (const word of part.split(/[_\-]+/)) {
      if (word.length >= 2) tokens.push(word);
    }
  }
  return tokens;
}

/**
 * High-frequency Chinese domain terms -> English counterparts.
 *
 * The catalog (tool names/descriptions) is English, so a pure-Chinese query only
 * matches the service token and returns unrelated tools — e.g. "Vercel 运行时
 * 错误 日志" used to return fork_drive/get_drive (Gemini real-world probe,
 * 2026-11-22). These terms are scored at half weight and without the flat
 * identifier bonus, which rescues unknown-tool queries without letting a generic
 * term (页面/page) outrank a real name match. Sorted longest-first so "未合并"
 * wins over the "合并" substring (consumed ranges prevent double-mapping).
 */
const CJK_SYNONYMS = [
  ['运行时', ['runtime']], ['错误日志', ['error', 'log', 'logs']], ['错误', ['error', 'errors']],
  ['报错', ['error']], ['日志', ['log', 'logs']], ['部署', ['deployment', 'deployments']],
  ['项目', ['project', 'projects']], ['页面', ['page', 'pages']], ['评论', ['comment', 'comments']],
  ['仓库', ['repository', 'repositories', 'repo']], ['分支', ['branch', 'branches']],
  ['提交', ['commit', 'commits']], ['未合并', ['open']], ['没合并', ['open']], ['合并', ['merge']],
  ['拉取请求', ['pull', 'request', 'requests']], ['数据库', ['database', 'databases']],
  ['数据源', ['data', 'sources']], ['表格', ['table', 'tables']], ['文档', ['document', 'documents']],
  ['工作区', ['workspace']], ['团队', ['team', 'teams']], ['域名', ['domain', 'domains']],
  ['账单', ['billing']], ['用量', ['usage']], ['密钥', ['secret', 'secrets']],
  ['环境变量', ['environment', 'variable', 'env']], ['通知', ['notification', 'notifications']],
  ['标签', ['label', 'labels']], ['里程碑', ['milestone']], ['周期', ['cycle']],
  ['发布', ['release', 'releases']], ['文件', ['file', 'files']], ['图片', ['image', 'images']],
  ['附件', ['attachment', 'attachments']], ['搜索', ['search']], ['搜一下', ['search']],
  ['查找', ['search']], ['找一下', ['search']], ['列表', ['list']], ['创建', ['create']],
  ['新建', ['create']], ['更新', ['update']], ['修改', ['update']], ['删除', ['delete']],
  ['成员', ['member', 'members']], ['用户', ['user', 'users']], ['最近', ['recent', 'latest']],
  ['最新', ['latest', 'recent']], ['失败', ['failed', 'error']], ['状态', ['state', 'status']],
  ['优先级', ['priority']], ['截止日期', ['due']], ['内容', ['content', 'contents']],
  ['读取内容', ['content', 'contents']], ['读取', ['read']], ['分配给我', ['assignee']],
  ['指派', ['assignee']], ['账号', ['account']], ['文件夹', ['folder']], ['视图', ['view']],
  ['环境', ['environment']], ['变量', ['variable']], ['记录', ['record', 'records']],
  ['未完成', ['open', 'todo']], ['分配', ['assignee']],
].sort((a, b) => b[0].length - a[0].length);

/** Expand a Chinese query with English catalog terms (no-op for non-CJK text). */
export function expandCjkQuery(text, existing = []) {
  if (typeof text !== 'string' || !CJK.test(text)) return [];
  const lower = text.toLowerCase();
  const out = new Set();
  const consumed = [];
  for (const [key, terms] of CJK_SYNONYMS) {
    if (/^[a-z0-9]+$/.test(key)) {
      const re = new RegExp(`(?<![a-z0-9])${key}(?![a-z0-9])`, 'g');
      if (re.test(lower)) for (const term of terms) out.add(term);
      continue;
    }
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(key, from);
      if (idx < 0) break;
      const end = idx + key.length;
      if (!consumed.some(([start, stop]) => idx < stop && end > start)) {
        consumed.push([idx, end]);
        for (const term of terms) out.add(term);
      }
      from = end;
    }
  }
  return [...out].filter((token) => !existing.includes(token));
}

/**
 * English abbreviations inside a Chinese query (e.g. "Linear 分配给我的 issue")
 * are query-signal, not fuzzy synonyms: they are promoted to full-weight tokens
 * so the plural identifier ("issues") can compete with the singular ("save_issue").
 * Non-CJK queries are never touched, so English ranking stays byte-identical.
 */
export function expandAsciiAbbrev(text) {
  if (typeof text !== 'string' || !CJK.test(text)) return [];
  const lower = text.toLowerCase();
  const out = new Set();
  const pairs = [
    ['issue', ['issues']],
    ['commit', ['commits']],
    ['repo', ['repositories']],
    ['pr', ['pull', 'request', 'requests']],
    ['dns', ['domain', 'record', 'records']],
    ['readme', ['file', 'contents']],
  ];
  for (const [key, terms] of pairs) {
    const re = new RegExp(`(?<![a-z0-9])${key}(?![a-z0-9])`, 'g');
    if (re.test(lower)) for (const term of terms) out.add(term);
  }
  return [...out];
}

function termFreq(tokens) {
  const tf = new Map();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
}

function normalizeServer(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

/**
 * Build a searchable index over catalog entries.
 * @param {{server: string, tool: string, name: string, description?: string}[]} entries
 */
export function buildIndex(entries) {
  const docs = entries.map((entry) => {
    const nameTokens = [...new Set(tokenizeIdentifier(`${entry.server} ${entry.tool} ${entry.name}`))];
    const descTokens = tokenize(entry.description ?? '');
    const identParts = new Set(nameTokens.filter((token) => !token.includes('__')));
    return {
      entry,
      // Main scoring signal: server + tool + name, split into identifier parts.
      nameTf: termFreq(nameTokens),
      // Held separate on purpose: description only feeds a capped tie-break.
      descTf: termFreq(descTokens),
      descBigrams: bigrams(descTokens),
      nameLen: nameTokens.length,
      descLen: descTokens.length,
      identParts,
      haystackName: `${entry.name} ${entry.tool} ${entry.server}`.toLowerCase(),
      haystackDesc: (entry.description ?? '').toLowerCase(),
    };
  });
  const df = new Map();
  for (const doc of docs) {
    for (const token of new Set([...doc.nameTf.keys(), ...doc.descTf.keys()])) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  let nameLenSum = 0;
  let descLenSum = 0;
  for (const doc of docs) {
    nameLenSum += doc.nameLen;
    descLenSum += doc.descLen;
  }
  return {
    docs,
    df,
    total: docs.length,
    avgNameLen: docs.length ? nameLenSum / docs.length : 0,
    avgDescLen: docs.length ? descLenSum / docs.length : 0,
  };
}

function idf(index, token) {
  const df = index.df.get(token) ?? 0;
  return Math.log(1 + (index.total - df + 0.5) / (df + 0.5));
}

function bm25(tf, len, avgLen, idfValue, k1 = 1.2, b = 0.75) {
  if (tf === 0) return 0;
  const norm = 1 - b + b * (len / (avgLen || 1));
  return idfValue * ((tf * (k1 + 1)) / (tf + k1 * norm));
}

/** Split "select:a,b" / "+server words" / plain keywords into a search request. */
export function parseQuery(raw) {
  const query = typeof raw === 'string' ? raw.trim() : '';
  if (query === '') return { kind: 'browse', query: '' };
  const select = /^select\s*:\s*(.+)$/i.exec(query);
  if (select) {
    const names = select[1]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    return { kind: 'select', names, query };
  }
  const server = /^\+\s*(\S+)\s*(.*)$/s.exec(query);
  if (server) {
    return { kind: 'keywords', server: server[1].toLowerCase(), query: server[2].trim() };
  }
  return { kind: 'keywords', server: null, query };
}

function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Match a tool against the allow/deny pattern list (`server/tool`, `server/*`, `*`). */
export function patternMatches(patterns, entry) {
  if (!patterns || patterns.length === 0) return false;
  const candidates = [`${entry.server}/${entry.tool}`, entry.tool, entry.name];
  return patterns.some((pattern) => {
    const regex = wildcardToRegExp(pattern);
    return candidates.some((candidate) => regex.test(candidate));
  });
}

/** Whether an entry passes the server's allow/deny policy. */
export function isAllowed(serverConfig, entry) {
  const deny = serverConfig.denyTools ?? [];
  if (deny.length > 0 && patternMatches(deny, entry)) return false;
  const allow = serverConfig.allowTools ?? [];
  if (allow.length > 0) return patternMatches(allow, entry);
  return true;
}

function sortByName(a, b) {
  return a.entry.name.localeCompare(b.entry.name);
}

// Scoring constants. The main signal is the name/identifier field; description
// is confined to a small CAPPED tie-break (term score and total are both
// bounded, so a long description cannot accumulate its way to the top).
const NAME_WEIGHT = 6;           // BM25 over server/tool/name identifier parts
const EXACT_NAME_BONUS = 50;     // query equals name or tool literally
const SUBSTRING_NAME_BONUS = 25; // query is contained in name or tool
const IDENT_TOKEN_BONUS = 6;     // query token equals an identifier word part
const IDENT_PARTIAL_BONUS = 2;   // query token is a prefix/substring of a part
const DESC_PER_TERM_CAP = 0.5;   // max description contribution of one term
const DESC_TIE_CAP = 10;         // total description ceiling (tie-break only)
const PHRASE_BONUS = 2;          // reward multi-word description overlap, not word count
const PHRASE_CAP = 12;
const STRONG_MATCH_SCORE = 30;   // exact/substring hits are exempt from the diversity cap
const DIVERSITY_CAP = 2;         // max results per server when no server filter is known

// Function words add noise to lexical matching ("list the issues" == "list issues").
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'of',
  'for', 'with', 'and', 'or', 'this', 'that', 'it', 'please', 'can', 'you',
  'i', 'my', 'by', 'from', 'as', 'be', 'do', 'does', 'did', 'have', 'has',
  'will', 'would', 'should', 'using', 'use',
]);

function contentTokens(tokens) {
  return tokens.filter((token) => !STOPWORDS.has(token));
}

function bigrams(tokens) {
  const result = new Set();
  for (let i = 0; i + 1 < tokens.length; i++) result.add(`${tokens[i]} ${tokens[i + 1]}`);
  return result;
}

/**
 * Search the catalog.
 *
 * Ranking is structured in three layers:
 *   1. service attribution — `options.server`, `+server`, or a server token in
 *      the query becomes a hard filter, so same-named tools from other
 *      services cannot compete;
 *   2. name/identifier matching — BM25 over split identifiers plus explicit
 *      exact/substring bonuses. Descriptions never accumulate score here;
 *   3. diversity — with no service attribution, cap each server's share of the
 *      top results so one large service (e.g. 273 Vercel tools) cannot crowd
 *      out the others. Strong exact matches are never demoted by this cap.
 *
 * @param {{server: string, tool: string, name: string, description?: string, inputSchema?: object}[]} entries
 * @param {string} rawQuery
 * @param {{limit?: number, maxLimit?: number, server?: string, diversityCap?: number}} [options]
 * @returns {{matches: object[], total: number, hint?: string}}
 */
export function searchEntries(entries, rawQuery, options = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 5, options.maxLimit ?? 10));
  const query = parseQuery(rawQuery);
  const explicitServer = normalizeServer(options.server);

  if (query.kind === 'select') {
    const matched = [];
    const seen = new Set();
    for (const name of query.names) {
      const exact = entries.find(
        (entry) =>
          (!explicitServer || String(entry.server).toLowerCase() === explicitServer) &&
          (entry.name.toLowerCase() === name.toLowerCase() || entry.tool.toLowerCase() === name.toLowerCase()),
      );
      if (exact && !seen.has(exact.name)) {
        seen.add(exact.name);
        matched.push({ ...exact, score: 1000 });
      }
    }
    return {
      matches: matched.slice(0, limit),
      total: matched.length,
      hint: matched.length === 0 ? 'No exact name matched. Use "select:" only with a name copied literally from a previous result; otherwise search by keywords.' : undefined,
    };
  }

  const index = buildIndex(entries);
  let serverFilter = explicitServer ?? query.server;
  const haystack = query.query.toLowerCase();
  const queryTokens = tokenize(query.query);
  const scored = [];

  // Detect a service name anywhere in the query (e.g. "create a notion page").
  // Preserves the original auto-filter behaviour; an explicit option wins.
  const servers = new Set(entries.map((e) => String(e.server).toLowerCase()));
  for (const tok of queryTokens) {
    if (servers.has(tok) && !serverFilter) serverFilter = tok;
  }

  const normalizedQuery = query.query.trim().toLowerCase();
  const baseContentTokens = contentTokens(queryTokens);
  const asciiExtra = expandAsciiAbbrev(query.query);
  // Dedupe only when abbreviations were added, so English ranking is unchanged.
  const scoringTokens = asciiExtra.length > 0
    ? [...new Set([...baseContentTokens, ...asciiExtra])]
    : baseContentTokens;
  const expandedTokens = expandCjkQuery(query.query, scoringTokens);
  const descScoringTokens = [...scoringTokens, ...expandedTokens];
  const queryBigrams = bigrams(scoringTokens);
  for (const doc of index.docs) {
    if (serverFilter && String(doc.entry.server).toLowerCase() !== serverFilter) continue;
    let score = 0;
    for (const token of scoringTokens) {
      score += NAME_WEIGHT * bm25(doc.nameTf.get(token) ?? 0, doc.nameLen, index.avgNameLen, idf(index, token));
    }
    // CJK expansion gets BM25 only at half weight — no flat identifier bonus, so
    // it can rescue an otherwise-unmatched Chinese query without beating a real
    // name match.
    for (const token of expandedTokens) {
      score += 0.5 * NAME_WEIGHT * bm25(doc.nameTf.get(token) ?? 0, doc.nameLen, index.avgNameLen, idf(index, token));
    }
    if (query.query === '') {
      score = 1;
    } else {
      const nameLower = doc.entry.name.toLowerCase();
      const toolLower = String(doc.entry.tool ?? '').toLowerCase();
      if (normalizedQuery && (nameLower === normalizedQuery || toolLower === normalizedQuery)) {
        score += EXACT_NAME_BONUS;
      } else if (normalizedQuery.length >= 3 && (nameLower.includes(normalizedQuery) || toolLower.includes(normalizedQuery))) {
        score += SUBSTRING_NAME_BONUS;
      }
      if (doc.haystackName.includes(haystack)) score += 12;
      for (const tok of scoringTokens) {
        if (doc.identParts.has(tok)) {
          score += IDENT_TOKEN_BONUS;
        } else if (tok.length >= 3) {
          for (const part of doc.identParts) {
            if (part.length >= 3 && (part.startsWith(tok) || part.includes(tok))) {
              score += IDENT_PARTIAL_BONUS;
              break;
            }
          }
        }
      }
      // Description is a capped tie-break, never the main ranking signal:
      // each term contributes at most DESC_PER_TERM_CAP, the total at most
      // DESC_TIE_CAP, and multi-word overlap is rewarded so a long description
      // cannot win by piling up unrelated single words.
      let descScore = 0;
      for (const tok of descScoringTokens) {
        descScore += Math.min(
          DESC_PER_TERM_CAP * bm25(doc.descTf.get(tok) ?? 0, doc.descLen, index.avgDescLen, idf(index, tok)),
          DESC_PER_TERM_CAP,
        );
      }
      score += Math.min(descScore, DESC_TIE_CAP);
      let phraseScore = 0;
      for (const phrase of queryBigrams) if (doc.descBigrams.has(phrase)) phraseScore += PHRASE_BONUS;
      score += Math.min(phraseScore, PHRASE_CAP);
    }
    if (score > 0) scored.push({ ...doc.entry, score: Number(score.toFixed(4)) });
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  let pool = scored;
  // Diversity applies only when no service attribution is known, to real
  // keyword searches, and only when more than one service actually matched.
  if (!serverFilter && query.query !== '' && scored.length > 0) {
    const presentServers = new Set(scored.map((s) => String(s.server).toLowerCase()));
    if (presentServers.size > 1) {
      const cap = Math.max(1, Math.min(options.diversityCap ?? DIVERSITY_CAP, limit));
      const perServer = new Map();
      const picked = [];
      for (const item of scored) {
        const server = String(item.server).toLowerCase();
        const used = perServer.get(server) ?? 0;
        if (used >= cap && item.score < STRONG_MATCH_SCORE) continue;
        perServer.set(server, used + 1);
        picked.push(item);
        if (picked.length >= limit) break;
      }
      pool = picked;
    }
  }
  const matches = pool.slice(0, limit);
  let hint;
  if (matches.length === 0) {
    hint =
      'No tool matched. Try fewer or English keywords (tool names are identifiers), or "select:<exact name>" with a name from a previous result.';
  } else if (scored.length > matches.length) {
    hint = `${scored.length} tools matched; showing ${matches.length}. Narrow the query or raise limit (max ${options.maxLimit ?? 10}).`;
  }
  return { matches, total: scored.length, hint };
}
