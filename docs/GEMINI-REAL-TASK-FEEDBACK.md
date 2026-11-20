# Gemini 真实项目任务反馈（优化清单）

> 2026-11-21。来源：一次 Gemini 里对真实项目执行真实任务的完整反馈。
> 这是迄今最有价值的输入——不是抽象任务，是实战里踩出来的问题。
> **本文件只记录，不改代码。** 改造顺序由用户决定。

## 核心结论

`search` + `execute`（CodeMode）架构在**多步批量编排**上价值显著，但本次实战暴露：
- 1 个阻断级协议 Bug（丢弃 MCP `resource` 内容块）
- 1 个违背设计初衷的上下文泄漏（`toolCalls` 全量回显写参）
- 5 处沙箱与交互短板

全部基于真实调用记录。

---

## 一、P0 阻断与架构级缺陷

### 1. MCP 多段 `content` 响应被拍平，`resource` 块直接丢失（阻断级 Bug）

- **实测现象**：调 `github__get_file_contents` 读文件时，返回值退化成纯字符串 `"successfully downloaded text file (SHA: 91f35b3a...)"`，文件内容完全丢失。
- **根因**（已在代码确认）：`src/tool-format.js` 的 `unwrapResult` 只提取 `type:"text"` 或带 `text` 字段的 content 块。GitHub MCP 返回多段 content：第 0 项是 text 状态提示，第 1 项是 `type:"resource"`（`resource.text` 存实际源码）——被过滤掉。
- **后果**：无法直接读文件，被迫在 execute 内手写 `list_commits` + 14 次 `get_commit(full_patch)` 逆向拼补丁 + 手写纯 JS SHA-1 校验——1 次调用变成几十次。
- **修复建议**：完整保留并解析 content 数组中所有 `type:"text"` 与 `type:"resource"`（含 `resource.text` / `resource.blob` / `resource.uri`）。多块共存时返回结构化对象（如 `{ text, resources, raw }`）或按规则完整拼接，不静默丢弃非首块。

### 2. `toolCalls` 回显全量 `args`，破坏"省上下文"核心承诺

- **实测现象**：execute 工具描述声明 "Only your returned value enters the conversation"，但调 `github__push_files` 推 10 个文件时，网关返回的 `toolCalls` 审计数组把 10 个文件的**完整源码内容（数万字符）原封不动塞回上下文**。
- **根因**：`src/codemode.js` 的 `runInSandbox` 里 `toolCalls.push({ name, args })`，args 未做截断，且整个 toolCalls 随 execute 结果返回。
- **修复建议**：toolCalls 审计对 args 严格截断/摘要（单字段超 200 字符截断为 `"<string len=28200>"`，数组只留项数 + key 摘要），真正兑现"只有 return 值进入上下文"。

---

## 二、P1 运行时与工程体验短板

| 维度 | 真实摩擦 | 改造建议 |
|---|---|---|
| **读写未分离导致高频审批** | execute 单入口固定标 `destructiveHint:true, readOnlyHint:false`，即便脚本只做 get_commit 纯读，宿主也频繁拦截，导致多次手动点"始终允许" | 拆 `execute_read`（`readOnlyHint:true, destructiveHint:false`，沙箱仅挂载上游 readOnly 工具）与 `execute`（全量可写）。只读探查零打断。 |
| **沙箱缺失基础 Web 标准 API** | 脚本内 `TextEncoder` 报 `ReferenceError`；UTF-8 编码、Base64（atob/btoa）、哈希都要手写纯 JS | 沙箱注入：`TextEncoder`/`TextDecoder`、`atob`/`btoa`、`URL`/`URLSearchParams`，轻量 `crypto.digest('SHA-1'\|'SHA-256')` 或 `utils.hash` |
| **30 次调用硬上限且超限整轮作废** | 触发 `tool call limit (30) exceeded` 后报错中断，已拉取数据全丢，下轮重拉 | ① 上限提到 50 或只读更高配额；② 同轮内相同只读调用（method+args）进程内去重/短缓存；③ 暴露 `codemode.remainingCalls()` 供脚本分批 |
| **返回值类型不统一 + 二次序列化** | ① 上游返回有时 JSON 字符串有时对象，代码里到处 `typeof x === "string" ? JSON.parse(x) : x`；② 网关把 execute 的 return 值再套一层 JSON.stringify，模型收到双层转义字符串 | ① 上游合法 JSON 文本在网关层自动 JSON.parse 后喂沙箱（失败回退 string）；② execute 外层响应直接返回结构化 JSON，减少双重转义 |
| **`listTools()` 默认输出过重** | `codemode.listTools()` 返回全量冗长 description，输出被截断（26,339 字符），挤占上下文 | 默认只返回 `{ name, service, readOnly, summary(<=80字) }`，或支持 `codemode.listTools({ service, brief:true })` |

---

## 三、已验证做对的设计（保留）

- **单轮批量编排**：把"拉历史 → 内存校验修改 10 个文件 → push_files 原子提交 → 建 PR"压缩进单次 execute，原本 20+ 轮工具交互压到 1 轮，且避免中间状态污染主分支。
- **按需 Schema 发现（search + select:<name>）**：未把全量 JSON Schema 塞进系统提示词，紧凑参数签名（`owner!: string`）信息密度高，几乎零冗余。

---

## 四、建议改造顺序

1. **P0（立刻修）**：修 MCP resource 内容块解包；裁剪 execute 返回体 `toolCalls[].args` 大字段回显。
2. **P1（高收益）**：拆 `execute_read`/`execute` 解决只读审批；沙箱补 TextEncoder/atob/btoa/URL；统一上游 JSON 自动反序列化。
3. **P2（打磨）**：同轮只读调用去重缓存、listTools 精简模式、报错附脚本文本行号与截断后的 logs。

---

## 代码定位（供改造时参考）

- P0-1：`src/tool-format.js` `unwrapResult()` line 50-63（过滤 `type:"text"`，漏 `type:"resource"`）
- P0-2：`src/codemode.js` `runInSandbox()` 里 `toolCalls.push({ name: tool.name, args })`（args 不截断），且 toolCalls 随结果返回
- P1 读写分离：`src/codemode.js` `executeTool` 的 annotations（line ~110）固定 `destructiveHint:true`
- P1 沙箱全局：`src/codemode.js` sandbox 对象（line ~65）只注入 JSON/Math/Date 等，缺 TextEncoder/atob/URL
- P1 30 次上限：`src/codemode.js` `DEFAULT_MAX_CALLS = 30`
- P1 listTools：`src/codemode.js` `codemode.listTools = () => tools.map(...)` 返回全量 description
