# 沙箱安全说明（诚实版）

> 2026-11-21。基于一次子代理 review 的发现。

## 结论：vm 沙箱不是安全边界

一次实测发现：`runInSandbox` 里 `Buffer.constructor("return process.version")()` 能逃逸拿到宿主 process（返回 `v24.16.0`）。

**根因**：Node 的 `vm` 模块官方文档明确说 "The `vm` module is not a security mechanism"。任何注入到沙箱的宿主函数（console.log、atob、crypto.digest 等），其 `.constructor` 都指向宿主 `Function`，沙箱代码可通过 `fn.constructor("...")()` 执行宿主代码。`codeGeneration: {strings:false}` 挡不住这条路径。

Cloudflare Code Mode 用的是隔离 Worker（`globalOutbound: null`），Anthropic 用无网络容器——那才是真隔离。我们这个 Node vm 做不到。

## 已做的加固

1. **不再把 `Buffer` 对象暴露给沙箱**——`typeof Buffer === 'undefined'`（已测试）。编码辅助函数（atob/btoa）在闭包里用宿主 Buffer，但对象本身不进沙箱。
2. **修复 base64 乱码**：`unwrapResult` 里资源 blob 用 `Buffer.toString('utf8')` 解码，不再用会变 latin1 的全局 `atob`（已测试中文正确）。
3. **移除误导性安全承诺**：`execute_read` 描述不再说 "No approval needed"，改为"This tool is annotated read-only so the client may prompt less; it runs the same sandbox as execute()"。

## 现实定位（不隐瞒）

- 这个网关是**个人工具**，execute 里跑的是**你自己（或你信任的 Gemini）写的代码**，不是攻击者输入。
- 沙箱的价值是**防意外**（脚本写错不会污染主进程、工具调用有上限、结果有界），**不防恶意逃逸**。
- `execute_read` 的读写分离价值在于 **annotations 让客户端少弹确认框**（readOnlyHint:true），不是安全隔离——如果模型真写了恶意代码，read 工具集也能被逃逸绕过。
- 如果这个网关将来要给不受信任的用户用，必须换成真隔离（Cloudflare Worker / 容器 / isolated-vm），不能靠 Node vm。

## 参考
- Node vm 官方警告：https://nodejs.org/api/vm.html
- Cloudflare Code Mode SDK（隔离 Worker）：https://github.com/cloudflare/agents/tree/main/packages/codemode
- Anthropic Code execution with MCP：https://www.anthropic.com/research/code-execution-with-mcp
- Review 原始报告：work/review-fixes.md
