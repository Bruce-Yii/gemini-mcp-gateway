# B10 · P0-3 / P0-4：端到端文件 patch 写入 + dry-run diff（host 侧纯模块）

> 状态：✅ host 侧纯模块已落地，**未接入 codemode / 上游写工具**。
> 对应 `batch-10-pr-workflow.md` 中 P0-3（补丁级写入端到端）与 P0-4（dry-run 写前预览）。
> 本次只新增 3 个文件，未修改 `src/codemode.js` / `src/upstreams.js` /
> `src/result-normalize.js` / README / CHANGELOG，不 commit、不 push、不 deploy。

## 一、交付内容

| 文件 | 作用 |
|---|---|
| `src/file-write.js` | 纯函数 `applyTextPatch` + 可注入 I/O 的异步编排 `applyFilePatch` |
| `tests/file-write.test.js` | fake read/write 回归测试（16 条，全部通过） |
| `docs/ledger/batch-10-patch-write.md` | 本台账（用法、风险、现状） |

## 二、API 契约

### 1. `applyTextPatch(rawText, unifiedDiff)`（纯函数）

- 解析 `@@ -a,b +c,d @@` hunk，忽略 `---` / `+++` / `\ No newline` 头与前后噪声行。
- **strict context 校验**：每个 context(` `) / removal(`-`) 行必须与原文对应行逐字符相等；
  任一不等即整体失败。`hunk` 的 `oldStart` 越界或倒退同样失败。
- 失败：`{ ok:false, error, text:原文 }`。**永不部分写入**——`text` 始终是规范化后的原文。
- 成功：`{ ok:true, text, added, removed, hunks }`。
- 多 hunk：按出现顺序应用，各自独立偏移。
- CRLF 归一：原文与 patch 的 `\r\n` / 单独 `\r` 统一为 `\n` 后再比对。
- 末尾换行保守处理：结果保留原文“是否有末尾换行”的状态，不信任 `\ No newline` 标记。

### 2. `applyFilePatch({ read, write, path, patch, dryRun = true })`

- `read(path)` 返回当前文本；应用 patch；生成简洁 diff 摘要：
  `{ path, added, removed, hunks, diff }`（`diff` 为 `--- a/path` / `+++ b/path` / `@@` 开头的可读文本）。
- `dryRun` **默认为 true**：不调用 `write`，返回 `{ ok:true, diff }`，不含 `commitSha` / `content`。
- 仅当 `dryRun:false` 且 patch 成功时才 `write(path, newText)`；
  成功返回 `{ ok:true, diff, commitSha?, content? }`（兼容上游 `commitSha` / `sha` 字段）。
- 任何失败（read 抛错、context mismatch、write 抛错、上游返回 `ok:false`）原样返回
  `{ ok:false, error, diff? }`，绝不假装成功。
- 依赖完全注入：模块不 import GitHub / MCP / codemode 任何东西。

## 三、如何用在上游写路径（read → apply → write）

上游写工具（以 GitHub `get_file_contents` / `create_or_update_file` 为例）应由**调用方**
把工具返回包装成 `read` / `write`：

```js
import { applyFilePatch } from './src/file-write.js';

// 1) read：把上游 get_file_contents 的结果解出纯文本
const read = async (path) => {
  const r = await callTool('github__get_file_contents', { path, ref: branch });
  const obj = JSON.parse(r.content[0].text);
  return Buffer.from(obj.content, 'base64').toString('utf8');
};

// 2) write：把新文本提交到上游（需要 sha 时由调用方从 read 结果里带出）
const write = async (path, text) => {
  const r = await callTool('github__create_or_update_file', {
    path, branch, content: text, message: 'patch via gateway', sha: currentSha,
  });
  return JSON.parse(r.content[0].text); // { commitSha } / { content }
};

// 3) 先 dry-run 预览，确认 diff 再真正写
const preview = await applyFilePatch({ read, write, path, patch, dryRun: true });
if (!preview.ok) throw new Error(preview.error);
console.log(preview.diff);           // +N/-M / hunk 摘要

const result = await applyFilePatch({ read, write, path, patch, dryRun: false });
// result.commitSha / result.content 由上游返回透传
```

要点：
- **dry-run 与真实写是两次独立调用**，各自独立 read，避免读到写后的内容。
- `write` 返回的 `sha` / `commitSha` / `content` 会被透传；若上游返回 `ok:false`
  则整次调用失败，不会误报成功。
- `read` 的 `sha` 等元数据可闭包捕获，供 `write` 用作乐观锁（本模块不做 CAS）。

## 四、为什么必须先校验（strict context 的必要性）

1. **大文件靠行号定位会漂移**：模型看到的往往是 `sliceLines` 片段或截断视图，
   其 `@@ -a,b @@` 行号基于旧快照；若上游文件已被他人更新，未校验的写入会覆盖别人的改动。
2. **避免部分写入**：多 hunk patch 中只要一个 hunk 的上下文不匹配，整篇 patch 必须整体拒绝，
   否则文件会停在“改了一半”的中间态，且 `dry-run` 摘要也会失真。
3. **dry-run 的可信度**：diff 摘要必须来自真正应用后的结果；若校验放宽，
   `+N/-M` 与 hunk 数就不能代表真实变更，写前预览即失去意义。
4. **失败不写 = 默认安全**：`applyFilePatch` 默认 `dryRun:true`，
   调用方必须显式 `dryRun:false` 才会触碰上游，符合“模型只读、写需确认”的网关原则。

## 五、未接入 codemode 的现状（明确边界）

- `src/codemode.js` 里的 `codemode.applyPatch` / `diffSummary` 仍是沙箱内字符串 helper，
  只在 guest 脚本里改内存中的字符串，**没有**“读上游文件 → 校验 → 写回 → 返回 diff”的编排。
- 本模块是 host 侧纯实现，**没有**改动沙箱注入列表（`SANDBOX_PREAMBLE`），
  因此 `codemode.applyFilePatch(...)` 目前不存在；模型在 `execute` 里无法直接调用它。
- 要真正端到端，还需后续工作（不在本次范围）：
  1. 把 `applyFilePatch` 包装成基于 `callTool` 的上游 read/write 适配器；
  2. 决定是注入沙箱还是作为网关层工具暴露；
  3. 加上 CAS / sha 乐观锁、commit message 策略与权限确认；
  4. 用真实 capture 回放 + L1 smoke 验证（免费模型输出只作假设，见 AGENTS.md）。

## 六、测试与风险

- **测试**：`tests/file-write.test.js` 16 条（成功、context mismatch 不写、dry-run 不写、
  多 hunk、write 抛错、read 抛错、上游 ok:false、CRLF、末尾换行、参数校验等）；
  `npm test` 全量通过。
- **风险（已知 / 待接）**：
  - 未接入上游与 codemode，当前不可被模型端到端调用（这是刻意的分阶段边界）。
  - 未做 CAS：`read` 与 `write` 之间文件被他人修改时，strict context 会拒绝写入并报错，
    但不会自动重试/合并。
  - diff 摘要是**可读预览**，不是可重新 apply 的标准补丁；真正的 patch 是传入的 `patch` 参数。
  - 仅支持基于 `@@` 行号的 unified diff；不支持 git binary patch / rename 等复杂 hunk。
