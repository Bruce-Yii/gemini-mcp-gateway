# B15 — Code Mode 在线反馈 6 项体验修复 + 安全审计补充（2026-11-23）

> 范围（本批只写以下文件）：
>
> - `src/result-normalize.js`（修改）
> - `src/codemode.js`（修改）
> - `src/github-helpers.js`（修改）
> - `tests/codemode-ergonomics.test.js`（新增，26 项离线回归）
> - `docs/ledger/batch-15-codemode-ergonomics.md`（新增，本台账）
>
> 额外授权：`tests/result-normalize.test.js:157-161`、`tests/gh-file-p0.test.js:144-152`
> 两组旧断言按新 contract 更新（只改这两处，保留其它语义）。
>
> **未改** `src/server.js`、`src/vercel-app.js`、`src/capture.js`、`src/typed-plan.js`、
> `scripts/`、其它 tests、README、workflows、契约文档。未 commit / push / deploy。
> 所有测试为伪 fixture、不联网；凭据未触碰。

## 一、目标与依据

按用户 2026-11-23 在线反馈（PR #77–#80 实测）修 6 个 Code Mode 体验问题，并纳入
lead 转来的安全审计补充（guest canonical adapters 丢 `truncated`、raw upstream 未标记）。
按 `AGENTS.md`：先写确定性回归测试，再改代码，最后跑全量测试验证，不据模型建议直接改代码。

## 二、逐项修复与证据

### F1（P0）文件内容 `content` 混入下载提示 → 纯正文

- **根因**：`normalizeFileResult` 在「只有提示、无 resource」时把提示当正文返回；
  `contentArrayToString` 用宽泛的 `SHA:` 匹配过滤候选，误杀真实正文；
  guest `fileResult` 只在部分形状剥前缀。
- **修复**（`src/result-normalize.js`、`src/codemode.js`）：
  - `pureFileText` 统一在所有正文候选上剥前缀；提示只进 `notice`/`noticeSha` 非枚举元数据。
  - notice-only → `content === ''`（固定语义），SHA 仍从提示提取。
  - `isDownloadNotice` 收窄为「短状态行 / 带 SHA 的下载前缀」，避免误杀正文。
  - guest `fileResult.content` 恒为纯正文，新增 `codemode.fileMeta()` 暴露 notice 元数据，
    保持原六字段集合不变；`readFileRange` 经 host adapter 得到纯正文行。
  - host bridge 把 notice/truncation 转为可枚举字段交给模型；`raw` 标注 `untrusted-upstream-envelope`。
- **证据**：`tests/codemode-ergonomics.test.js` F1 组 6 项；
  `tests/result-normalize.test.js`、`tests/gh-file-p0.test.js`、`tests/gpt-online-fix.test.js`
  的 byte-exact roundtrip / 长行 / resource URI 断言全绿。

### F2（P0）PR `number` 偶尔为内部 ID → URL 优先

- **修复**（`src/result-normalize.js`、`src/github-helpers.js`）：
  - `numberFromUrl` 支持 `/pull/53`、`/pulls/53`、query/hash 边界；
  - 新增 `findNumberUrl` 扫描 root / `result` / `items[0]` / `pull_request` 链接，
    覆盖 create/list/get/merge 形状；
  - `id` / `node_id` 仅保留为字符串独立字段，永不作 `number` 兜底；
  - guest `prResult` / `canonicalize` / `normalizeMerge` 与 host 一致。
- **证据**：F2 组 5 项（含真实 `{id:5444514334, url:/pulls/53}` fixture）。

### F3（P1）批处理包装不一致 → 统一扁平契约

- **修复**（`src/codemode.js` guest prelude）：
  - 新增 `codemode.unwrapBatch(x)`：单值 / `{result}` envelope / `{ok,value}` 槽 / 数组
    → 统一返回扁平 `{ok,value}[]`；嵌套数组展开为独立槽。
  - `safeAll` 失败槽形状恒为 `{ok:false,value:<error text>}`，与成功槽同构。
  - 指引写入两个 execute 描述，明确“不要再手剥一层”。
- **证据**：F3 组 3 项。

### F4（P1）大返回整块截断 → 显式截断元数据

- **修复**（`src/codemode.js`）：模型边界新增 `withTruncationMetadata()`：
  - 仅在边界**确实发生截断**时附加 `truncation:{truncated,field,totalChars,tail,next}`；
  - 保留原 in-band `--- TRUNCATED ---` 标记与尾部字段名；
  - 元数据紧凑以维持 `maxResultChars` 预算（600 → 富化后 699 chars，仍在旧断言 ≤700 内）。
- **证据**：F4 组 3 项 + 既有 `gateway-rest / no-silent-truncation / image-passthrough` 全绿。

### F5（P1）多文件逐文件提交 → 默认原子

- **修复**（`src/codemode.js` 指引）：execute 描述明确优先 `codemode.writeFiles`
  （`github__push_files` 一次原子提交）；仍逐文件且失败时，原有非原子路径返回
  `partial:true` / `written[]` / `remaining[]` / `compensation`，要求向用户明示。
- **证据**：F5 组 2 项（含第 k 个写入失败的 fake fixture）。

### F6（P2）CI 轮询碎 → 一次等待 helper

- **修复**（`src/github-helpers.js` + `src/codemode.js`）：
  - host `waitForPrChecks({owner,repo,pullNumber,timeoutMs,maxPolls,pollIntervalMs,check})`：
    硬上限 30s，返回最新 `{status,conclusion,checkRuns,polls,elapsedMs,timedOut}` 快照；
  - guest `codemode.waitForPrChecks()` 走**既有** `pull_request_read`
    (`method:"get_check_runs"`) 工具桥，不新增 MCP tool、不直连 REST、不碰 token。
- **证据**：F6 组 3 项（pending→completed 序列、maxPolls 超时、工具桥参数）。

### 安全审计补充

- guest `fetchAllPages` / `repoGrep` 与 host 对应函数均保留上游 `truncated`
  （并新增 `upstreamTruncated`），不再把被截断的页/文件当完整数据集。
- `raw` / `result` 原始上游值保留但显式标注 `untrusted-upstream-envelope`
  （`UNTRUSTED_RAW_MARKER`，非枚举以保持历史字段集合）。
- **证据**：SEC 组 5 项。

## 三、测试

- 新增 `tests/codemode-ergonomics.test.js`：26 项，全部为本地伪 fixture，无网络。
- 定向：`node --test tests/result-normalize.test.js tests/codemode-ergonomics.test.js
  tests/b10-codemode.test.js tests/gh-file-p0.test.js tests/gpt-online-fix.test.js
  tests/gh-feedback-fixes.test.js tests/online-gap-regression.test.js` → **152/152 pass**。
- 全量 `npm test` → **1329 tests / 1323 pass / 0 fail / 6 todo**（最终数字以 lead 复跑为准）。
- 清理了 3 个临时调试脚本（`work/tmp-*.mjs`），未留产物。

## 四、风险 / 部署后复验

1. 用户反馈来自**旧构建**；本批只是代码层修复 + 离线回归，现网状态仍为「待部署验证」。
2. notice-only 的 `content === ''` 是新固定语义；调用方不得再把 `notice` 当正文。
3. 截断元数据使用紧凑字段名（`field/totalChars/tail/next`），文档已说明；如后续调整
   需同步 `tests/codemode-ergonomics.test.js` 与 `gateway-rest.test.js` 的预算断言。
4. `waitForPrChecks` 依赖上游 `pull_request_read` 的 `get_check_runs` 方法；若某会话未挂载
   该工具，helper 返回 `ok:false` 明确错误，不猜测、不降级为手工轮询循环。
