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

function termFreq(tokens) {
  const tf = new Map();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
}

/**
 * Build a searchable index over catalog entries.
 * @param {{server: string, tool: string, name: string, description?: string}[]} entries
 */
export function buildIndex(entries) {
  const docs = entries.map((entry) => {
    const nameTokens = tokenize(`${entry.server} ${entry.tool} ${entry.name}`);
    const descTokens = tokenize(entry.description ?? '');
    return {
      entry,
      nameTf: termFreq(nameTokens),
      descTf: termFreq(descTokens),
      nameLen: nameTokens.length,
      descLen: descTokens.length,
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

/**
 * Search the catalog.
 * @param {{server: string, tool: string, name: string, description?: string, inputSchema?: object}[]} entries
 * @param {string} rawQuery
 * @param {{limit?: number, maxLimit?: number}} [options]
 * @returns {{matches: object[], total: number, hint?: string}}
 */
export function searchEntries(entries, rawQuery, options = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 5, options.maxLimit ?? 10));
  const query = parseQuery(rawQuery);

  if (query.kind === 'select') {
    const matched = [];
    const seen = new Set();
    for (const name of query.names) {
      const exact = entries.find(
        (entry) => entry.name.toLowerCase() === name.toLowerCase() || entry.tool.toLowerCase() === name.toLowerCase(),
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
  const serverFilter = query.server;
  const haystack = query.query.toLowerCase();
  const queryTokens = tokenize(query.query);
  const scored = [];

  for (const doc of index.docs) {
    if (serverFilter && doc.entry.server.toLowerCase() !== serverFilter) continue;
    let score = 0;
    for (const token of queryTokens) {
      const tokenIdf = idf(index, token);
      score += 4 * bm25(doc.nameTf.get(token) ?? 0, doc.nameLen, index.avgNameLen, tokenIdf);
      score += bm25(doc.descTf.get(token) ?? 0, doc.descLen, index.avgDescLen, tokenIdf);
    }
    if (query.query === '') {
      score = 1;
    } else {
      if (doc.haystackName.includes(haystack)) score += 8;
      if (doc.haystackDesc.includes(haystack)) score += 2;
    }
    if (score > 0) scored.push({ ...doc.entry, score: Number(score.toFixed(4)) });
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const matches = scored.slice(0, limit);
  let hint;
  if (matches.length === 0) {
    hint =
      'No tool matched. Try fewer or English keywords (tool names are identifiers), or "select:<exact name>" with a name from a previous result.';
  } else if (scored.length > matches.length) {
    hint = `${scored.length} tools matched; showing ${matches.length}. Narrow the query or raise limit (max ${options.maxLimit ?? 10}).`;
  }
  return { matches, total: scored.length, hint };
}
