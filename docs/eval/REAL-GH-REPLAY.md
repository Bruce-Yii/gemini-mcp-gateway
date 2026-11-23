# 真实 GitHub（只读）回放：PR number/id 与 Actions 日志 helper 修复

> 日期：2026-11-23 · 范围：只新增三个文件，未改 `src/`、其它 scripts/tests、README、workflows；
> **未 commit / push / deploy**。token 从 `GITHUB_TOKEN` env 或本地 vault
> （`D:\12412\dsh-home\.secrets\gemini-mcp-gateway\github-auth.json`）读取，
> 只进请求头，绝不打印、不写证据、不进错误文案。

## 一、目的

对 batch 15（`gpt-online-fix`）在线暴露、但只在本地 fake fetch 下验证过的两个修复，
做一次**真实 GitHub 只读端到端复核**：

1. PR `number` 与数据库 `id` 必须分离——`number` 是 URL 里的小号，`id` 是长 DB id，不能混用。
2. Actions job 日志端点用 `Accept: application/vnd.github+json` 请求（不再 415），
   302 到 signed URL 后不带 Authorization 跟随、取回文本；日志只留长度与脱敏摘要。

## 二、复现命令

```bash
# 真实只读回放（需 GITHUB_TOKEN，或已配置 vault）
node scripts/real-gh-replay.mjs

# 使用环境变量 token（优先于 vault）
GITHUB_TOKEN=ghp_xxx node scripts/real-gh-replay.mjs

# 网络无关的 fake-fetch 回归（不需要 token，不联网）
node --test tests/real-gh-replay.test.js
```

输出是 JSON 证据（stdout）；token 不在其中（`tokenSource` 只标注来源，
`tokenPrinted:false`）。脚本只读，不写任何文件。

## 三、真实结果（2026-11-23T02:11:23Z，vault token，`overallOk: true`）

### 3.1 PR 列表 `GET /repos/Bruce-Yii/recruitment-agent/pulls?state=all&per_page=100`

- HTTP 200，返回 48 条 PR；#53/#56/#57/#59 全部找到。

| PR | `number` | `id`（长 DB id） | `node_id` | `html_url` |
|---|---|---|---|---|
| #53 | 53 | 1000000001 | `PR_kwDOEXAMPLE000000000001` | `https://github.com/example-org/example-repo/pull/53` |
| #56 | 56 | 1000000002 | `PR_kwDOEXAMPLE000000000002` | `https://github.com/example-org/example-repo/pull/56` |
| #57 | 57 | 1000000003 | `PR_kwDOEXAMPLE000000000003` | `https://github.com/example-org/example-repo/pull/57` |
| #59 | 59 | 1000000004 | `PR_kwDOEXAMPLE000000000004` | `https://github.com/example-org/example-repo/pull/59` |

- 断言结果：每个 `numberIsSmall=true`、`idIsLongDbId=true`、`id !== String(number)`、
  `numberNotId=true`。**真实数据确认 id 与 number 是两个不同的量，不能把 id 当 number。**

### 3.2 PR 单条 `GET /repos/.../pulls/53`

- HTTP 200；`number=53`、`id=1000000001`、`node_id=PR_kwDOEXAMPLE000000000001`、
  `html_url=https://github.com/example-org/example-repo/pull/53`；`numberNotId=true`。

### 3.3 Actions 日志 `GET /repos/.../actions/jobs/100000000001/logs`

- 首跳请求头 `Accept: application/vnd.github+json`（**不再是 octet-stream**）、带 Authorization。
- 结果：HTTP 200、`no415=true`（415 未出现，修复生效）、返回日志文本。
- `saw302: false` —— 如实记录：Node 的全局 fetch 在 `redirect:'follow'` 下自动跟随了 GitHub
  的 302 并直接返回最终 200，因此没有向脚本暴露中间 302。脚本本身保留显式 302 处理分支
  （`hop2`：不带 Authorization、`Accept: */*` 跟随 signed URL），由 fake-fetch 测试覆盖。
- 日志**不打印全文**，只输出：长度 `211826` 字符 + 前 200 字符脱敏摘要
  （`2026-11-23T00:50:08...Z Current runner version: '2.338.2'...`）。`redacted=true`。
- 若 token 无权限/过期（401/403）或 415 真出现，脚本会把 HTTP 状态与错误如实写入
  `errors` 并 `overallOk:false`，不会伪造通过。本次无此类错误（`errors: []`）。

## 四、测试（fake fetch，不联网）

`node --test tests/real-gh-replay.test.js` → **14/14 pass, 0 fail**。覆盖：

- PR #53/#56/#57/#59 的 number/id 分离、缺 PR 如实报错、`state=all&per_page=100` URL；
- PR #53 详情的 number/id/nodeId/htmlUrl；
- Actions 日志首跳 JSON Accept、302 → signed URL **不带 Authorization**、跟随 Accept `*/*`、
  200 取文本；直接 200 不重定向也通过；真实 415 会被标失败；
- 日志摘要只含长度/脱敏 200 字符、全文不进证据；
- token 不出现在证据 JSON；无 token / 401 / 403 如实记录失败，不伪造。

## 五、与 `gpt-online-fix` 的对应关系

| gpt-online-fix 条目 | 本地确定性测试 | 本次真实回放 |
|---|---|---|
| F1 Actions 415（octet-stream → `application/vnd.github+json`；302 signed URL 不带 token） | `tests/gpt-online-fix.test.js` 首跳 Accept 断言、415 结构错误、302/200 | 真实 job 100000000001 日志 HTTP 200、无 415；首跳 JSON Accept；302 由 fetch 自动跟随（显式分支由 fake 测试覆盖） |
| F4 PR `id`/`nodeId` 与 `number` 分离（PR #59 fixture） | `tests/gpt-online-fix.test.js` PR59 fixture + guest/host/canonical 三方一致 | 真实 #53/#56/#57/#59 `id` 均为长 DB id 且不等于小号 `number`；#53 详情 id/nodeId/htmlUrl 记录完整 |
| 日志脱敏（不打印全文） | `logDigest` 单测 | 真实日志只输出长度 + 前 200 字符脱敏摘要 |

结论：batch 15 台账中「待真实窗口验证」的两项——Actions 415 消失与 PR id/number 区分——
在真实、只读、无凭据外泄的前提下得到确认。`gpt-online-fix` 在线记录状态仍由人决定是否升级；
本回放只提供证据，不改在线评测状态、不改契约、不合并、不部署。

## 六、变更控制

仅新增：
- `scripts/real-gh-replay.mjs`
- `tests/real-gh-replay.test.js`
- `docs/eval/REAL-GH-REPLAY.md`

未改其它文件；未 commit / push / deploy；无凭据入仓。
