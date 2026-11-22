# Real GitHub write replay（2026-11-23）

> 目的：验证 B10 写路径不是“只在 fake 测试里过”，而是在真实 GitHub 仓库完成
> `create_branch → create_file → dryRun patch → real patch → verify → cleanup`。

## 环境

- 仓库：`Bruce-Yii/gemini-mcp-gateway`
- 测试分支：`codex/write-replay-20261123`（测试后已删除）
- 文件：`work/write-replay.txt`
- 执行路径：本地 `UpstreamManager`（真实 GitHub MCP）→ `createCodeModeTools` → `execute` → `codemode.applyFilePatch`
- 凭据：vault 内 GitHub token，不写入仓库/日志

## 结果

1. 从 `main` 创建测试分支：成功，base commit `16403be...`
2. 创建文件 `one\ntwo\nthree\n`：成功，blob sha `4cb29ea...`
3. `applyFilePatch(dryRun:true)`：
   - `ok:true`
   - diff `+1/-1`，hunk 1
   - 未写
4. `applyFilePatch(dryRun:false)`：
   - `ok:true`
   - `sha` = 新 blob `ddc897f...`
   - `commitSha` = `f4edd7f...`
   - 顶层字段齐全，无 URL 正则会话
5. 校验分支上文件正文为 `one\nTWO\nthree\n`：通过
6. 删除测试分支：完成，仓库无残留

## 发现并修复的真实 bug

真实写入不是单元测试能覆盖的，这次抓到 3 个连串问题：

1. **`{text, resources}` 形状再次把下载提示当正文**
   - `text = "successfully downloaded text file (SHA: ...)\nbody"`
   - 修复：`normalizeFileResult` 在 text 是下载提示/含提示时优先 `resources[].text`。
2. **blob sha 没从 download notice 提取**
   - 文件读取结果没有顶层 `sha` 字段；旧逻辑返回 null，写入时被 GitHub 拒绝。
   - 修复：从 `SHA: <hex>` 提取 sha，供 `applyFilePatch` 自动补 sha。
3. **写入结果嵌套没解析**
   - GitHub 返回 `{content:{sha}, commit:{sha}}`；旧逻辑把旧 blob sha 当 commitSha、新 sha 为 null。
   - 修复：`normalizeWriteResult` 读 `content.sha`/`commit.sha`；顶层固定 `sha` + `commitSha`。

## 结论

- B10 写路径**真实可用**：单文件 patch、dryRun、自动 sha、真实 commit 都通过。
- 真实回放抓到了 3 个 fake 测试没覆盖的字段问题；以后写路径改动必须先跑这个回放。
- 多文件写入仍是非事务性（预检失败整批不写；写阶段中途失败可能留前序文件），已记录在风险中。

## 复现

```bash
# 需要 GITHUB_TOKEN（vault）
node scripts/replay-write.mjs --yes
```

（当前脚本在 `work/` 本地执行；集成版本见后续。
测试分支/文件在成功后自动清理。）
