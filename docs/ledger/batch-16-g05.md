# Batch 16 · G-05 — `commitSha` 被 `blobSha` 覆盖

> 日期：2026-11-24（Asia/Singapore）。来源：全仓库审计 G-05。
> 状态：本地工作树已修 + 确定性回归测试。**未 commit / push / deploy。**
> 生产仍是 `d1f36ba`（AGENTS.md §0），本次改动不在生产构建内。

---

## 0. 边界与写作用域

只改以下三个文件（外加 lead 授权的 b11 旧断言一处，见 §3）：

- `src/file-write.js`（修复）
- `tests/fix-g05.test.js`（新增回归测试）
- `docs/ledger/batch-16-g05.md`（本文档）

不联网、不接触真实凭据、不改工具面（三工具 `search` / `execute_read` / `execute` 的名称/顺序/schema 未变）、
不改 `src/codemode.js`、不改 push_files 的 root `sha` 语义、不改 capture。

---

## 1. 语义厘清（根因）

`file-write.js` 里存在**两类不同的 sha**，来自**不同的上游结果**：

| 字段 | 语义 | 上游来源（GitHub 写回形状） |
| --- | --- | --- |
| `commitSha` | 提交身份（commit creation） | `create_or_update_file` 的 `commit.sha` 或顶层 `commitSha`；`push_files` 的返回对象本身（root `sha`）|
| `blobSha` / `sha` | 文件/内容身份（file write） | `create_or_update_file` 的 `content.sha` 或顶层 `sha` |

G-05 的根因在 `applyFilePatch`（host 单文件 legacy 写路径，修复前 319–322 行）：

```js
const blobSha = writeResult.sha ?? nestedContent?.sha;          // 文件写入结果
const commitSha = writeResult.commitSha ?? nestedCommit?.sha;   // commit 创建结果
if (commitSha !== undefined) out.commitSha = commitSha;
if (blobSha !== undefined) out.commitSha = blobSha;             // ← BUG：blob 覆盖 commit
```

当上游同时返回 blob sha 和 commit sha（GitHub `create_or_update_file` 的标准形状就是
`{content:{sha}, commit:{sha}}`），第二行会把第一行写入的 `commitSha` 直接替换成 blob sha。
结果：模型/编排器拿到的 `commitSha` 实际是文件内容 sha，**提交身份被静默伪造**。

历史证据：`tests/b11-write-transaction.test.js` 旧断言（218–220 行）写死
`assert.equal(written.commitSha, 'b-a.json')` 并注释 “the blob sha overrides commitSha”，
把这个 bug 当作“历史行为”固化下来——属于把缺陷当契约的测试债。

---

## 2. 修复

### 2.1 `src/file-write.js` · `applyFilePatch`

- `commitSha` **只**从 commit 创建结果读取：`writeResult.commitSha ?? nestedCommit?.sha`。
- blob 身份**只**从文件写入结果读取：`writeResult.sha ?? nestedContent?.sha`，
  同时暴露为 `sha`（保留既有 blob 字段语义/兼容名）和显式 `blobSha`。
- 两个字段并列写入、互不覆盖；字段仅在上游真正返回对应身份时才出现。
- 更新 JSDoc `@returns` 与 G-05 契约说明。
- 现有 API 不变：函数签名、参数、`ok`/`diff`/`content` 等字段均保持；只新增 `sha`/`blobSha` 两个可选字段。

修复后片段：

```js
if (commitSha !== undefined) out.commitSha = commitSha;
if (blobSha !== undefined) {
  out.sha = blobSha;
  out.blobSha = blobSha;
}
```

### 2.2 未改的部分（有意为之）

- `normalizeWriteResult`（多文件/原子 push 用的归一化器）**未改**：
  - push_files 返回的是 commit 对象，其 root `sha` 语义就是 commit sha；
  - 该函数的 `pick(['commitSha','commit_sha','sha'])` 候选表服务于这一语义，
    改动会影响 `push_files` 路径以及 `b10-write-semantics` / `b11-write-transaction` 中
    4 处对 sandbox 返回键集合的精确断言（`['commitSha','diff','files','ok','sha']`），
    超出本次写作用域。
  - 因此本次只在新测试里**锁定「flat 形状两者并存不覆盖」契约**，并在 §5 明确记录已知限制。
- `src/codemode.js` 未改：sandbox 侧 `codemode.applyFilePatch` 走 `normalizeWriteResult`，
  其 flat 形状（`{commitSha:'c', sha:'b'}`）本来就取 `commitSha` 优先，不存在本次覆盖 bug。

---

## 3. 测试改动

### 3.1 新增 `tests/fix-g05.test.js`（13 项，全部离线）

覆盖任务要求 2 的四类返回形状：

1. **同文件 / 单文件 patch**：GitHub 真实形状 `{content:{sha}, commit:{sha}}` →
   `commitSha='commit-new'`，`sha`/`blobSha='blob-new'`，两者不相等；
   另覆盖 flat `{commitSha, sha}`、仅 commit、仅 blob、dryRun 四种边界。
2. **多文件（per-file 写回退）**：`writeFiles` 两个文件顺序写，`commitSha` 取自最后一个文件的
   commit 结果、`sha` 取自其 blob 结果，验证跨文件仍不覆盖。
3. **原子 push（push_files）**：root `sha` 作为 commit sha 的既有语义保持；
   `commitSha` 与 `sha` 一致是 push 形状的正确行为，不是 G-05（无 blob 身份）。
   另覆盖 `{commit:{sha}, content:{sha}}` 无 root `sha` 的形状。
4. **单文件 patch 返回形状 / `normalizeWriteResult`**：flat 与 nested 两种“两者并存”形状都验证
   `commitSha` 与 `sha` 分离；同时断言上游无身份时返回 `null` 不猜字段。

另有一项显式锁定**已知限制**（§5）：`normalizeWriteResult({sha:'blob', commit:{sha:'commit'}})`
当前仍返回 `commitSha='blob'`；并有一项证明 host `applyFilePatch` 路径**不受**该限制影响。

### 3.2 `tests/b11-write-transaction.test.js`（lead 授权的 218–220 一组断言）

- 旧：`assert.equal(written.commitSha, 'b-a.json')`（固化 bug）。
- 新：`commitSha === 'c-a.json'`（commit 结果），`sha === 'b-a.json'`、`blobSha === 'b-a.json'`（blob 结果）。
- 该文件其他断言未改。

---

## 4. 证据（本地实跑）

```text
node --test tests/fix-g05.test.js
ℹ tests 13
ℹ pass 13
ℹ fail 0

node --test tests/b11-write-transaction.test.js
ℹ tests 19
ℹ pass 19
ℹ fail 0

node --test tests/healthz.test.js   # 复核下方 flaky 项
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

全量 `npm test`（本次改动后）目标：0 fail。以 lead 汇总的最近一次全量结果为准；
若出现 `tests/healthz.test.js` 的 `write-build-info --print is deterministic ...` 失败，
那是并发改动 `src/build-info.js` 输入导致的构建哈希漂移（该文件单跑 4/4 pass），
与 G-05 无关，需在其他 agent 停止写盘后复跑确认。

---

## 5. 未验证项 / 已知限制

- **未部署 / 未在线复验**：生产仍 `d1f36ba`；本次只在本地工作树。部署后需重跑写回环与在线复验。
- **未 commit**：无 git 提交，无 push，无 PR。
- **`normalizeWriteResult` 的 root `sha` 优先级**：当 payload 为
  `{sha:'blob', commit:{sha:'commit'}}` 且无 flat `commitSha` 时，root `sha` 会优先于
  `nestedCommit.sha` 成为 `commitSha`。这是为兼容 push_files（root `sha` 即 commit sha）
  而保留的语义，属已知限制；彻底修复需按写路径区分归一化器（单文件 create_or_update_file
  与多文件 push_files 分流），超出本次范围。本次通过新测试把它显式钉住，避免被误认为已修。
- **真实上游响应**：所有测试使用本地复刻的 GitHub MCP 响应形状，未打真实 GitHub API；
  真实 payload 若有本仓库未覆盖的字段组合，需另行复验。
- **并发全量测试**：多个 agent 同时改工作树时 `healthz` 的 build-info 确定性测试可能偶发失败
  （见 §4），不代表 G-05 回归。
- **capture / 安全**：未触碰 capture，无脱敏改动，双投影边界不变。
