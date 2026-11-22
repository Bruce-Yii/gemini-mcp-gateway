# Batch 11 — 仓库级「静默截断同类项」审计与 CI 守门

日期：2026-11-23
状态：脚本 + 测试 + CI 步骤已落地；当前基线 **P0=0**（CI 守门为绿灯）。
范围：`scripts/audit-truncation.mjs`（新增，纯只读）、`tests/audit-truncation.test.js`（新增）、
`.github/workflows/ci.yml`（仅追加审计步骤）、本文档。未修改 `src/`、其他测试、README、
CHANGELOG、其他脚本，也未 commit / push / deploy。

## 1. 目标与方法

不再靠人眼找「同类」的静默截断。审计脚本是一个**词法、只读**扫描器：
不 import / 不执行项目代码、不写文件、不访问网络。扫描范围为
`src/`、`scripts/`、`tests/`、`harness/`、`bench/` 下的 `.js/.mjs/.cjs`，
跳过 `node_modules`、`.git`、`dist`、`coverage`、`data`、`docs`、`.github`。

关注两类信号：

1. 字符串裁尾：`String.slice(n)` / `.slice(0, n)` / `.substring(n)` / `.substr(n)`；
2. 显式上限调用点：`truncate` / `truncateResultValue` / `truncateResponseText` /
   `boundResult` / `sliceLines` / `boundLogs` / `compactDescription`，以及带
   `maxChars` / `maxBytes` / `maxLength` 等上限标识符的 cut。

分级（与任务要求一致）：

| 级别 | 含义 | 退出码影响 |
| --- | --- | --- |
| **P0** | 生产路径（`src/`）静默截断且无标记 | **非零（1）**，CI 失败 |
| **P1** | 上下文 / 结果可能截断且无标记（`scripts/`、`harness/`、`bench/`） | 仅警告，**不影响退出码** |
| **P2** | 日志 / 展示截断；或截断处有显式标记 | 仅记录，**不影响退出码** |

「有标记」的判据：同文件定义了标记常量/函数（`--- TRUNCATED ---`、
`truncationSuffix`、`…[truncated]`、`…[+N chars]`、`[REDACTED]`、`TRUNC_MARKER`
等），或截断语句所在代码块（前后若干行）出现 `truncated from`、`hint:`、
`showing N`、`narrow the query`、`chars total`、`more items`、`truncated` 标志等
可观察提示。标记让模型/人知道内容被裁掉，因此降到 P2 并在此登记。

## 2. 当前基线

```
[audit-truncation] scanned 111 files: P0=0 P1=2 P2=177
```

分类明细（按路径前缀汇总）：

- P0：**0**
- P1：**2**（均非 `src/`，警告级）
- P2：177，其中 82 为显式豁免（argv、日期前缀、前缀剥离、数组窗口、分隔位切分），
  94 为带标记或日志/展示场景，1 为无标记但在展示路径。

## 3. 命中清单

### 3.1 P0（生产路径未标记截断）

**当前无命中。** 这是 CI 守门的前提：`node scripts/audit-truncation.mjs --ci`
在未提交改动的基线上退出码为 0。新增任意 `src/` 内无标记字符串裁尾都会让 CI 变红。

### 3.2 P1（上下文 / 结果可能截断，未标记，仅警告）

| 位置 | 信号 | 说明 | 后续修复归属 |
| --- | --- | --- | --- |
| `bench/run.mjs:122` | `(text \|\| JSON.stringify(result)).slice(0, 8000)` | bench 把模型答案 / JSON 结果硬裁到 8000 字符后落盘，无 `truncated` 标记；仅影响评测记录，不影响生产模型上下文。 | benchmark / eval 负责人；建议在 `bench/run.mjs` 的写入处补 `answerTruncated` 字段或 `…[truncated N]` 后缀后复扫。 |
| `scripts/gen-figma-tasks.mjs:74` | `description.split('.')[0].toLowerCase().slice(0, 140)` | 生成任务 prompt 时对工具描述做句首截断，属于生成模板的展示文本；无标记但读者能从 prompt 上下文看出是摘要。 | task-generation 负责人；如需严谨，可在该模板里给截断描述加 `…`。 |

### 3.3 P2（可接受，但在此注明）

无标记但属日志 / 展示 / 错误消息的代表性命中（均不进模型结果上下文）：

- `src/oauth.js:315` — `sha256(...).slice(0, 32)` 生成 client_id 前缀（标识符，不是内容）。
- `src/oauth.js:364,551` — `console.log` 中 `redirect.slice(0,90/80)`，仅日志展示。
- `src/store.js:87,153` — 错误消息里 `text/detail.slice(0, 300)`，帮助排障。
- `scripts/check-task-coverage.mjs:123` / `scripts/eval-search.mjs:64` — 报告里的 `prompt.slice(0, 100/90)`。
- `scripts/probe-mcp-2026.mjs:127` / `scripts/analyze-captures.mjs` / `scripts/join-online-offline.mjs`
  — HTTP body / capture 摘要的定长截断，多数伴随 `…[truncated]` 或 `truncated` 标志。
- `bench/run.mjs:94,192` — 错误尾行 `buffer.slice(-500)` 与 `answer.slice(0, 2000)` 展示/记录。

带标记的 P2 主要来自生产截断实现本身（这些是**正确做法**，不是缺陷）：

- `src/tool-format.js` — `truncateResponseText` / `truncateResultValue` 统一产出
  `--- TRUNCATED --- <n> chars total` + locating hint，数组/对象保留结构标记。
- `src/server.js` — `boundResult()` 产出 `… [truncated N chars by gateway: limit …, original …]`
  并给出收窄查询的指引。
- `src/codemode.js` — `boundLogs()` / sandbox 返回值经 `truncateResultValue` 截断，
  同样带 `--- TRUNCATED ---`。
- `src/catalog.js` — `matches.slice(0, limit)` 后返回 `total` 与 `hint`
  （`N tools matched; showing M. Narrow the query or raise limit …`）。
- `src/upstream-auth.js:104` — capture 副本 `text.slice(0, 64*1024) + '…[truncated]'`。
- `src/sanitize.js:145,228` — `MAX_BRANCHES` 截断会 `appendDescriptionHint`，
  name 截断到 Gemini 63 字符上限属于 schema sanitize（协议约束，见下节豁免）。

## 4. 已豁免项与理由

扫描器把这些明确排除在「静默截断」之外，计入 P2/exempt 并保留在 `--json` 报告中以便复核：

| 类别 | 例子 | 理由 |
| --- | --- | --- |
| argv / CLI 解析 | `process.argv.slice(2)`、`arg.slice('--config='.length)` | 参数解析，不碰 payload。 |
| 前缀 / 协议字段剥离 | `line.slice(1)`（diff 操作位）、`name.slice(0, separator)`（`server__tool` 分隔）、URLSearchParams 的 `?` 剥离 | 结构性拆分，不是「丢尾巴」。 |
| 日期前缀 | `iso.slice(0, 10)`、`raw.slice(0, 10)` | 取 YYYY-MM-DD，定长且语义完整。 |
| 数组窗口 | `items.slice(0, 3)`、`lines.slice(cursor)`、`events.slice(0, 3)` | 数组/argv receiver，不是字符串截断。 |
| 固定范围读取 | `slice(start, Math.min(...))`、`grepSnippet` 的 `s.slice(start, start+w)` | 区间可读，且 `truncated` 标记由上层给出。 |
| 测试 fixture | `tests/**` 中大量 `slice(0, N)` | 断言用的子串比对，不进入生产路径。 |
| cap 声明 / 配置透传 | `maxResultChars: config.maxResultChars`、`function shrink(value, maxChars)` | 只是上限定义/传递，不是 cut 调用点。 |

## 5. 持续 CI 守门

`.github/workflows/ci.yml` 在 `npm test` **之后**追加了一步（原测试命令未改）：

```yaml
- name: Audit silent truncation (P0 blocks, P1 warns)
  run: node scripts/audit-truncation.mjs --ci
```

约定：

- P0 ≥ 1 → 退出码 1，PR 被挡；P1 / P2 只输出，不失败（满足「不要让它因 P2 失败」）。
- `--json` 输出 `{ ok, filesScanned, counts, findings }`，便于后续接 dashboard / 断言。
- `--ci` 人类摘要只显示 P0/P1，P2 保留在 JSON 中以便按需查阅。
- `--root DIR` 允许对任意临时树扫描，测试用它验证退出码与分类。

## 6. 测试覆盖

`tests/audit-truncation.test.js`（15 个用例，全部通过）：

- fixture 验证 `src/` 无标记 cut → P0、cap cut → P0；
- `scripts/`、`bench/` 无标记结果截断 → P1；
- 有 `--- TRUNCATED ---` 标记 → P2；日志/错误消息截断 → P2；
- 豁免类（argv、日期、前缀、分隔符）不产生未豁免命中；
- 干净源码无命中；
- 真实 CLI + 临时 fixture 树验证退出码：P0 → 1（含 `--json`/`--ci`），
  P1-only → 0 且 `--ci` 仍打印警告，无命中 → 0 且 JSON `ok:true`；
- `--ci` 隐藏 P2 细节但 `--json` 保留；
- 仅扫描配置目录；
- 提交仓库的 `src/` 基线 P0=0（CI 守门契约回归）。

## 7. 后续修复归属与建议顺序

1. **P1 `bench/run.mjs:122`** — benchmark 负责人。给截断结果加标记字段并更新
   `tests/golden-mcpmark.test.js` 等相关断言后复扫。
2. **P1 `scripts/gen-figma-tasks.mjs:74`** — task-generation 负责人。模板字符串里加 `…`。
3. **持续维护** — 任何新 `src/` 截断必须复用 `src/tool-format.js` 的
   `truncateResultValue` / `truncateResponseText` 或 `src/server.js` 的 `boundResult`
   （它们都带标记）；若确需裸 `slice`，在相邻代码块写清 `hint`/`truncated` 标记，
   让扫描器判为 P2，并在本 ledger 追加豁免条目与理由。
4. **脚本自身演进** — 扫描器是启发式的；若出现新的截断原语（如新的 `bound*` helper），
   在 `CAP_RE` / `TRUNC_CALL_RE` / `MARKER_TOKENS` 中登记，并补一条 fixture 测试。

> 注意：按 AGENTS.md，任何来自免费模型分析的建议都只是待验证假设。本审计脚本
> 给出的是**位置与分级**，不是「必须修改」的结论；所有修复仍需人审复现与回归测试。
