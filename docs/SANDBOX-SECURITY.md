# 沙箱安全说明（诚实版）

> 2026-11-21。基于一次子代理 review 的发现，并按当前 HEAD `03c294b` 与 `work/full-audit.md` 校正。
> 旧版把下面第 1 条写成"已加固"属于夸大——**只挡了 Buffer 一条路径，其余宿主函数仍可逃逸**，见下文。

## 结论：vm 沙箱不是安全边界

一次实测发现：`runInSandbox` 里 `Buffer.constructor("return process.version")()` 能逃逸拿到宿主 process（返回 `v24.16.0`）。

**根因**：Node 的 `vm` 模块官方文档明确说 "The `vm` module is not a security mechanism"。任何注入到沙箱的宿主函数（console.log、atob、crypto.digest 等），其 `.constructor` 都指向宿主 `Function`，沙箱代码可通过 `fn.constructor("...")()` 执行宿主代码。`codeGeneration: {strings:false}` 挡不住这条路径。

Cloudflare Code Mode 用的是隔离 Worker（`globalOutbound: null`），Anthropic 用无网络容器——那才是真隔离。我们这个 Node vm 做不到。

## 做了哪些改动（**不等于**"已加固"）

> 关键更正：下面 3 项里只有第 1 项与安全沾边，而且它**只挡住了 Buffer 这一条路径**。
> 不能据此宣称沙箱"已加固"，也不能把 `readOnlyHint` 当隔离边界。

1. **移除 `Buffer` 这一条逃逸路径（仅此一条）**——沙箱对象里不再暴露 `Buffer`，`typeof Buffer === 'undefined'`（已测试）；编码辅助函数（atob/btoa）在闭包里用宿主 Buffer，但对象本身不进沙箱。
   **但 `src/codemode.js:316-337` 注入的其它宿主函数仍是普通对象字面量**：`TextEncoder`、`console.log`、`atob`、`URL`、`codemode.*` 的 `.constructor` 依旧指向宿主 `Function`，`fn.constructor("...")()` 仍可执行宿主代码（`work/final-review-report.md:148` 实测 5 条路径全通）。`codeGeneration: {strings:false}` 挡不住这条路径。
2. **修复 base64 乱码**（非安全项）：`unwrapResult` 里资源 blob 用 `Buffer.toString('utf8')` 解码，不再用会变 latin1 的全局 `atob`（已测试中文正确）。
3. **移除误导性安全承诺**（仅文案项）：`execute_read` 描述不再说 "No approval needed"，改为"This tool is annotated read-only so the client may prompt less; it runs the same sandbox as execute()"。

## 正在加固 / 尚未落地（别写成"已修"）

- **Proxy 止血**：`work/full-audit.md` #47 指出 `src/codemode.js:316` 目前仍是普通 `sandbox` 对象，无 `harden()` / Proxy。若 `fix-codemode-rest` 那条代理已经把 Proxy 止血合入，以当前源码为准重新核对——**在确认合入且补上回归测试之前，不要写成"已挡住 constructor 逃逸"**；未合入则状态就是"正在加固中"。
- **无逃逸回归测试**：`work/full-audit.md` #59 —— `tests/` 下没有任何断言 `.constructor → process` 被挡住的用例；`tests/security-fixes.test.js` 只覆盖其它安全项。
- **真正的隔离边界尚未引入**：Cloudflare Worker / 容器 / isolated-vm（`package.json` 目前未引入相关依赖）；Node vm 做不到真隔离。

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
