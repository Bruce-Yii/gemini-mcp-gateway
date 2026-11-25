# ChatGPT A/B 对组实测：MCP Gateway 通道 vs Direct MCP 通道（2026-11-25）

> **性质**：同一客户端（ChatGPT）、同一套权威题（T1 · AT-GH-01 / AT-LN-01 / AT-XU-01）、
> 同一生产构建 `1328787` 下的**双通道对照**。两份原文各自独立保存，本文件只做并排结论，
> 不回写、不裁剪任何一方原文。
>
> - Gateway 侧：`active-eval-2026-11-25-chatgpt-gateway-gate5.json`（`ae_20261125_58ba7cbe`）
> - Direct 侧：`active-eval-2026-11-25-chatgpt-directmcp-gate5.json`（`ae_20261125_86e4069d`）
>
> **约束**：两轮不是逐秒同时执行（Gateway `00:11:23–00:20:26Z`，Direct `00:28:47–00:36:09Z`），
> 生产构建相同，因此只能做**构建级**对照，不能做同秒对照。

---

## 1. 对照基线

| 项 | MCP Gateway | Direct MCP |
|---|---|---|
| 客户端 | `chatgpt` | `chatgpt` |
| 执行通道 | Gateway Code Mode（`search` / `execute_read`） | 直连 GitHub / Vercel / Linear / Notion / Figma 连接器 |
| 生产构建 | `1328787` | `1328787` |
| 权威文件 SHA | `d887ba35…` | `d887ba35…` |
| 任务集 | AT-GH-01 / AT-LN-01 / AT-XU-01 | 同左 |
| 写操作 | 0 | 0 |
| 网关写入调用 | 0（`execute` 未调用） | 0（未调用网关） |
| 可见 requestId | `unknown` | `unknown` |

## 2. 三项任务结果

| 任务 | Gateway | Direct MCP | 差异原因（证据） |
|---|---|---|---|
| **AT-GH-01** GitHub 大文件 | **PASS** | **PARTIAL 4/6** | Gateway `fileResult` 提供 `path` / `truncated` / `size` / `sha`，download notice 单独放 `notice`；Direct `fetch_file` **不返回 `path`、不返回 `truncated` 字段**，两项验收无法判定，只能另拉 raw 正文做逐字符复核 |
| **AT-LN-01** Linear 查询 | **PASS** | **PASS** | 两边都拿到 2 个团队、项目/Issue/评论，均无 Complexity 超限 |
| **AT-XU-01** 跨上游一致性 | **PARTIAL** | **FAIL-GOVERNANCE** | 两边都发现「生产 `1328787` 落后 main `69af629`」；Gateway 直接读到 `meta.githubCommitSha`、但 `servers` 字段无独立证据；Direct 进一步定位到 `faba0d8` 改了 `tool-format.js`（脱敏规则未上线） |
| Notion 前置 | 调用成功，**HTTP 状态未暴露** | 调用成功，**HTTP 状态未暴露** | 两边一致：都不能独立核验数字 200 |

**结论**：三项里唯一出现「一方能做、另一方做不了」的是 **AT-GH-01 的字段契约**——Gateway 统一封装提供了 `path`/`truncated`，Direct 侧连接器没有；这不是客户端能力差异，是上游工具契约差异被网关抹平。

## 3. 成本对照（实测数字，不做换算）

| 指标 | Gateway | Direct MCP |
|---|---|---|
| 模型发起调用轮次 | 11 次 `functions.exec` | 17 次 `functions.exec` |
| 通道层调用 | `search` 21 / `execute_read` 5 | 无通道层（直连） |
| 上游工具调用总数 | 13（单批最大并发 9） | 33（最大单批并发 8） |
| 不同上游工具数 | 8 | 13 |
| 工具发现成本 | 21 次 search + 12 次 Schema（10 个不同，2 次重复） | 0 次 search（连接器工具直接可见），13 个 Schema（15 次获取，2 次重复） |
| 超时 | **1 次** `execute_read` 超时（捕获 `durationMs=59995`，≈60s 上限） | 0 |
| 展示层截断 | 2 次 | 1 次 |
| 客户端脚本错误 | 0 | 2 次（`TextEncoder` 缺失、Blob 当 JSON 解析） |
| 无效查询 | 1 次（`.vercel/project.json` 不存在） | 0 |
| 可见时间窗 | `00:11:23–00:20:26Z`（≈9 分，取自捕获） | `00:28:47–00:36:09Z`（7 分 21.558 秒，客户端自报） |
| 主任务批次耗时 | 5.528 秒（9 并发 + 1 依赖串行） | 未单列（任务级 156.6s / 31.2s / 51.3s） |

两者都**未测得**：Token 数、模型上下文占用、审批次数（均 `unknown`/`unavailable`）。因此本文件不比较 Token 与端到端成本。

## 4. 能力边界：证据支持什么

### 4.1 Gateway 侧有证据的独有能力

1. **统一服务快照** `services()`：5/5 `observed` + `toolCount` + `verifiedAt`（GitHub 42 / Vercel 73 / Linear 27 / Notion 53 / Figma 47）。Direct 侧明确记为 `unavailable`，无等价接口。
2. **统一文件契约**：`fileResult` 把 `path/sha/size/truncated/notice` 分离——直接导致 AT-GH-01 可判 PASS，而 Direct 侧两项不可判。
3. **可被动审计**：这一轮的 25 条请求（`search` 20 / `execute_read` 5）全部落 R2 capture，才能做同窗对照并蒸馏出 `search_thrash` + `slow_or_unexpected`；**Direct 轮次在网关侧 0 条记录**，无法被动复核，只能核对它自报的 blob SHA（已核，全部一致）。
4. **单批跨上游 + 依赖编排**：一次 `execute_read` 内 9 个上游调用并发，再按 Issue 结果串行查评论。

### 4.2 Direct 侧有证据的优势

1. **无通道层发现成本**：0 次 search、无 Schema select 失败；但代价是 13 个连接器各一套契约。
2. **少一层跳转**：上游调用 33 次 vs Gateway 13 次（Gateway 沙箱内已合并部分调用），但两边耗时口径不同，不能直接得出谁更快。

### 4.3 两边共同踩到的问题

- 生产落后 main（`1328787` vs `69af629`，含未部署的 `lin_api_`/`ntn_`/`figd_` 脱敏规则）→ 已登记 BC-025。
- Notion 不暴露 HTTP 状态码，都无法把"调用成功"升级成"已验证 200"。
- `requestId` 均不可见。

### 4.4 不能证明的

- 谁更省 Token / 谁更快 / 谁审批更少 / 谁在长会话更稳：两边都没有遥测，**全部不作判断**。
- "Gateway 独有并发/编排"不成立：Direct 侧同样用 `functions.exec` 并发 8 路，两边都能做。

## 5. 结论

1. **跨通道对照成立**：同客户端、同题、同构建，唯一变量是通道。
2. **可验证的净差异只有一个方向**：Gateway 的统一契约让 AT-GH-01 可判 PASS；Direct 因连接器缺 `path`/`truncated` 只能 PARTIAL。其余任务两边同结果。
3. **Gateway 的额外成本是真实的**：21 次 search、2 次 Schema 名称失败、1 次 60 秒超时、2 次展示截断，都要记在账上，不能因为任务通过就省略。
4. **Direct 的最大短板是审计**：它不经过网关，因此本轮无法被 R2 被动日志复核；这是评测体系的覆盖缺口，不是 Diret MCP 的功能缺陷。
5. Gate 5 仍不签完整 PASS：Gateway 侧 AT-XU-01 的 `servers` 字段无独立证据，Notion 状态码不可观测。
---

## 6. 与官方 A/B 总结的差异校正（lead 复核）

官方总结原文见 [AB-2026-11-25-official-summary.raw.txt](AB-2026-11-25-official-summary.raw.txt)。总体判断（ChatGPT 环境下 Gateway 增量价值不明显）与本文件一致，但有 3 处需要按实测数据校正，1 处不能写的结论。

### 6.1 需要校正：审计/可观测性不是"潜在价值"，本轮已实证

官方总结把"执行审计"列在"尚未验证的潜在价值"。实测不是这样：

| 通道 | 网关 capture 记录 | 可否被被动复核 |
|---|---|---|
| Gateway | **25 条**（`search` 20 / `execute_read` 5，窗口 `00:11–00:20Z`） | **可以**：同窗 compare + 蒸馏命中 `search_thrash` / `slow_or_unexpected` |
| Direct MCP | **0 条** | 不可以，只能核对方自报的 blob SHA |

这是本轮**已经验证**的差异，不是"待验证的潜力"。

### 6.2 需要补充：Gateway 本轮可靠性更差，不是"无明显优势"

官方总结只说"没有明显效率优势"，漏了两个已经发生的成本：

- 首次 `execute_read` **超时**，捕获 `durationMs=59995`（≈60s 函数上限）；
- **2 次**客户端展示层截断（Direct 侧 1 次）。

所以更准确的说法是：**Gateway 在本轮有明显额外成本，且其中一项是可靠性退化**（BC-023），不只是"效率没优势"。

### 6.3 需要补充：契约标准化是唯一正向且已证的差异

AT-GH-01：Gateway **PASS**（`path`/`truncated`/`size`/`sha` 齐全，notice 与正文分离）vs Direct **PARTIAL 4/6**（`fetch_file` 无 `path`、无 `truncated`）。

### 6.4 不能写的结论：不能把"未证明优势"写成"证明无优势"

Token 数、端到端耗时、上下文占用、审批次数，两边**都没有遥测**。因此：

- 可以写：本轮未观察到 Gateway 的效率优势；
- 不能写：Gateway 没有效率优势（缺测量手段，属于 `NOT_ENOUGH`）。

同理，两组执行窗口相差 17 分钟、Direct 侧多做了 project/comments 查询，墙钟时间不可直接比较。

### 6.5 官方总结成立的部分

- ChatGPT 原生侧确实具备按需加载与多步骤编排能力（Direct 轮 0 次 search、8 路并发、串行依赖都实际发生）。
- "跨客户端复用 / 统一治理"本轮**未测**，既不能证实也不能证伪。
