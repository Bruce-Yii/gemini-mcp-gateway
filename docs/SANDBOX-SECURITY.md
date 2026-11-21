# 沙箱安全说明（诚实版）

> 2026-11-21 更新。当前状态基于 commit `633cb6f`（真隔离：Vercel `run` SDK / QuickJS）、
> `5ab2e47`（非法 runtime 字段修复），以及 `tests/true-isolation.test.js`、
> `docs/ledger/batch-0-history.md` TEST-H3 的线上探活证据。
> 旧版写的"vm 不是安全边界 / 真隔离尚未引入 / 只挡了 Buffer"是 node:vm 时代的历史状态，已过期，见文末对照表。

## 结论：真隔离已落地（引擎级边界）

旧结论"vm 沙箱不是安全边界"在 node:vm 时代成立：注入的宿主函数 `.constructor` 指向宿主 `Function`，
`fn.constructor("return process.version")()` 能逃逸拿到宿主 process（旧实测 `v24.16.0`），
`codeGeneration: {strings:false}` 挡不住这条路径。

当前 `src/codemode.js` 已迁移 Vercel `run` SDK（依赖 `run`，commit `633cb6f`）：guest 代码在 worker 线程内的
独立 QuickJS 引擎中执行，没有 `process` / `require` / `fetch` / Node 全局，内建原型被冻结，
`.constructor` 无法跨 realm 拿到宿主 `Function`。这是**引擎级真隔离**，不是 node:vm 那种"同一 V8 realm 里的伪沙箱"：

- 线上探活（`docs/ledger/batch-0-history.md` TEST-H3，`work/probe`）实测逃逸被挡：`Function constructor is not allowed`。
- 回归测试 `tests/true-isolation.test.js`：① 17 个注入值的 `.constructor` 全部无法执行宿主代码（40+2 哨兵）；
  ② guest 里 `process/require/Buffer/module/global/fetch` 与动态 `Function()` 全为 undefined / 失败；
  ③ 正常功能（工具调用、只读去重、Web API、crypto、错误结构）不变。
- 宿主侧还有额外约束：`createRunner` limits（timeout / cpuTimeout / `maxResultBytes` 16MB / `maxBridgeRequests` 2048）、
  wall-clock deadline（`withDeadline`）、调用上限 50 + 只读去重。

## 边界在哪：guest 隔离，host function 仍在宿主 realm 执行

引擎边界只挡"guest 代码直接摸到宿主能力"；guest 唯一能触达宿主的路径是 `__bridge.invoke`（`syncHostFunctions`）。
这个 bridge 背后的 `registry`（`log`/`atob`/`btoa`/`encode`/`decode`/`digest`/`listTools`/`search`/`remainingCalls`/`stub`/`tool`，
`src/codemode.js:388-445`）**全部在宿主进程里执行**——包括 `callTool()` 真正调用上游 MCP、参数校验、计数、去重、审计。

因此以下告诫在真隔离落地后依然成立，不能删：

- **沙箱隔离 ≠ 授权边界**：隔离负责"代码逃不出去"，授权必须宿主把门。工具可见性（`allowTools`/`denyTools`）、
  `validateToolArgs`（入参）、50 次上限、deadline、审计日志都在宿主侧完成（`src/codemode.js:424-444, 491-503`）。
- **注入到沙箱的 host function 是被信任的**：它们由宿主实现、按宿主规则受限，不要假设"进了沙箱就自动安全"。
  新增 bridge 能力等于新增宿主权限面，必须同步在宿主侧做校验与限额。
- **annotations 不可信**：`readOnlyHint` 等 tool annotation 来自上游，只影响客户端是否少弹确认框，**不是安全边界**。
  `execute_read` 把非只读工具换成 stub（抛 "use execute() instead"）；即使模型写了恶意代码，annotation 也不能把写工具变成只读，
  真正拦写的是宿主侧的工具过滤与 `stub`。不要因为某个工具标了 `readOnlyHint:true` 就跳过宿主的授权检查。

## 现实定位（不隐瞒）

- 这个网关是个人工具，execute 里跑的是你自己（或你信任的 Gemini）写的代码；引擎隔离防的是逃逸与误伤，
  但完整的宿主侧授权/限额仍然保留，两者是纵深防御的两层，不能互相替代。
- `execute_read` 的价值是减少客户端审批摩擦，不是安全隔离——这条告诫在真隔离落地后依然成立。
- 如果将来要给不受信任的用户用，引擎级隔离只是必要基础，仍要逐项审查 bridge 暴露的宿主能力（见上"host function 受信任"），
  不能只靠"有个沙箱"就宣称安全。

## 历史状态对照（旧版结论为何过期）

| 旧文案 | 当时的依据 | 现在 |
|---|---|---|
| "vm 不是安全边界 / 只挡了 Buffer 一条路径" | node:vm 时代 `4bf27f5`：移除 Buffer，其余注入函数 `.constructor` 仍可逃逸 | 已换 QuickJS 引擎，所有注入值 `.constructor` 探针全灭（`tests/true-isolation.test.js` ①） |
| "真正的隔离边界尚未引入" | 旧 `package.json` 无隔离依赖 | `run` SDK 已引入（`633cb6f`），线上探活 `Function constructor is not allowed` |
| "无逃逸回归测试" | `work/full-audit.md` #59 | `tests/true-isolation.test.js` 三个用例覆盖逃逸 / 宿主能力缺失 / 功能不变 |

## 参考

- Vercel `run` SDK（QuickJS 隔离）：https://www.npmjs.com/package/run
- 历史对照：Node vm 官方警告 https://nodejs.org/api/vm.html
- 线上探活证据：`docs/ledger/batch-0-history.md` TEST-H3（`work/probe`）
- 回归测试：`tests/true-isolation.test.js`
- 根因追溯：`docs/ledger/batch-2-rootcause.md`（SBX-1）
