# 交接说明（供新窗口参考）

> 这是一份描述性文档，记录项目现状、使用过的工作方式、踩过的坑。
> 它不是规范——新窗口请按自己的判断决定怎么做，包括判断是否采纳下面任何一条。

---

## 一、项目本身

### 是什么
给 Gemini 用的自定义 MCP 网关。核心形态是 **Code Mode**：对外只暴露 `search` + `execute`/`execute_read` 两三个工具，模型先搜工具、再写一段 JS 在沙箱里编排上游工具，只有脚本的 `return` 值进入对话上下文。

用户的核心诉求（原话）："核心还是省上下文。减工具只是因为有些用不上。"
三个衡量维度：准确性、速度、上下文——其中准确性优先。

### 架构现状
- 部署：Vercel serverless（`yu-ac3a`），稳定域名 `https://gemini-mcp-gateway-yu-ac3a.vercel.app`
- 协议：MCP Streamable HTTP，OAuth 2.1 DCR + PKCE
- 上游：GitHub / Notion / Linear / Vercel，四个服务共 191 个工具在当前配置里暴露
- 凭据：License 轮换 token 存在 Upstash KV（Marketplace 注入，本地读不到），`~/.gemini-gateway-tokens/` 有本地副本
- 沙箱：Vercel `run` SDK（QuickJS + worker thread），引擎级隔离——曾经历过 Node vm → Proxy 止血 → 真隔离的演进
- token 生命周期：`src/upstream-auth.js` 里有锁 + CAS fencing + invalid_grant 终态 + 自愈，是针对反复出事补出来的

### 文件地图（大致）
- `src/codemode.js` — Code Mode 工具、沙箱、search/services/grepSnippet 等 helper（最大的单点）
- `src/tool-format.js` — MCP content 联合类型解包、结构化截断
- `src/catalog.js` — search 检索与打分（做过一次重构）
- `src/upstream-auth.js` / `src/upstreams.js` — token 生命周期与上游连接
- `src/sanitize.js` / `src/tool-format.js` — schema 清洗、参数归一化
- `src/server.js` / `src/vercel-app.js` — MCP handler 与 HTTP 入口
- `docs/ledger/` — 分类×批次台账（B0 历史 / B1 场景 / B2 根因 / B3 重测）
- `docs/GEMINI-REAL-TASK-FEEDBACK.md`、`docs/EXPLORATION-FINDINGS.md` — 两批问题来源
- `explore/` — 探索测试框架（任务集 `tasks-v2.json` 191 条，runner 支持并发+免费模型 guard）

### 一个容易误解的点：Gemini 的重连
Code Mode 上线后，对外工具的名字和参数 schema 从没变过（只有 description 文字和后端逻辑在变）。因此这几天用户不重连 Gemini 也能用上最新版——这是正常的。
过去我多次说"要重连"，是过度谨慎。判断标准是：**只有工具名字或参数结构变了才需要重连**，后端逻辑改动不需要。

---

## 二、工作方式（当时怎么做，仅供参考）

### 台账
`docs/ledger/README.md` 定义了分类（SCENARIO/ISSUE/ROOT/FIX/TEST/DEC）× 批次（B0-B3）的记录方式，以及门控规则（前一批通过才进下一批）。
B1/B2/B3 都已完成并通过。台账里登记了所有决策和"接受（DEC）"的残留项。

### 反馈处理
用户在项目中明确要求过：**收到反馈先做逐层根源（表象→L1→L2→L3）→ 找同类 → 识别收益与风险 → 走一步看三步**，再动手。
用户批评过"给一批做一批"的工作方式，也批评过"提方案只讲收益、副作用等用户问才说"。

### 子代理
这个项目大量使用并行子代理。做过的方式是：**按文件写权限拆分**，每个代理只改自己的文件，避免互相覆盖。有一次多个代理并行时跨会话中断，成果丢失，之后改成盯着每个代理落地。

### 测试与部署
- `npm test`（本地纯单测，零成本）当前 286 项全绿
- 探索测试用免费模型 `hy4-flash-free` @ `https://opencode.ai/zen/go/v1`，runner 有硬 guard 拒绝扣费端点
  （历史上误用过付费的 hy4 跑大规模测试，用户对此明确不满）
- 部署用 Vercel CLI，token 在会话里临时注入；Vercel 配了 Git 自动部署（push main 即部署）
- Hobby 计划运行时日志只保留 30 分钟

---

## 三、踩过的坑（事实记录，不是规矩）

### OAuth / token（反复出事，两类相反的根因）
- **Notion**：刷太多——`bootstrapped` 标记没清导致每请求 refresh；并发冷启动抢轮换 token。修法：锁 + CAS + invalid_grant 终态 + 自愈。
- **Linear**：该刷没刷——配置缺 `obtainedAtEnv`，bootstrap 用 `Date.now()+expiresIn` 把过期 token 伪造成"刚签发还能用24h"，provider 返回 invalid_token 也没有 401 兜底。修法：补 obtainedAtEnv、401 强制刷新重连。
- 一个重要认知：**用户 DSH 里的 Linear 一直正常、从没要求重授权**——这证明是网关端代码问题，不是账号问题。当上游在别处正常、只有网关挂时，往这个方向查。
- 重新授权后需要同时更新 Vercel env + 重 seed KV + 重部署，光换 token 不够（有 envSeed 门控）。

### Gemini 反馈的性质
用户让 Gemini"试用感受"给的建议，质量高但性质是**一线症状报告，不是架构诊断**。它从模型视角看问题，看不到网关内部、安全权衡、实现成本。
多次出现"问题对但解法不是最优"的情况：
- toolCalls 回显：它建议截断，更好的解法是根本不发模型（toModelOutput）
- services() online：它建议显示状态，实现后出现"虚假安全感"（冷启动快照当实时健康）
- 描述太长：它建议截断，更深层病根是 description 参与了 BM25 打分导致"搜不准"
建议当探针用，不当工单用。

### 假错误与数据问题
- 官方示例任务里的占位符（`octocat/Hello-World`、`abc1234`、虚构 PR 号）在真实账号里不存在，产生大量假 404。探测器和台账里做过隔离。
- 探测器的归因误标曾经发生过（404 被贴 schema mismatch、execute detail 抓成 search 结果），修过并加了测试。
- 探索测试用静态 access token 禁 refresh，避免抢生产 grant。

### 我（前窗口）犯过的认知错误，供参考
- **Firecrawl 额度判断**：只看快照没逐个实测，说三个 key 全空——其实 key3 满的。用户指出了。
- **Cloudflare normalize 函数**：把错误信息当官方函数名传播，后来逐文件读源码才发现 Cloudflare 根本没有这个函数（只有 normalizeCode 处理代码文本）。
- **部署非法 runtime 字段**：凭印象加了 `"runtime": "nodejs22.x"`，Vercel 直接 ERROR。
- **副作用不说**：提优化方案时只讲收益，副作用等用户问才讲。用户原话"我要是不问你，不就炸了吗"。
这几条的共同 L3 被归纳为"有权威依据可支配却没去用 / 选择性诚实"，台账 evidence rules 里有记录。

### 2026-11-22 Gemini 残留反馈处置（3 条）

> 来源：Gemini 网页端上一轮的实测反馈（用户转述）。逐条复现/测量后处置如下，数字是本地实测（2026-11-22）。

| 反馈 | 结论 | 证据 / 处置 |
|---|---|---|
| 沙箱内 `codemode.<tool>()` 不支持 `.then()` / `.catch()`，报 `not a function` | **真 bug，已修** | 复现：工具方法返回桥接层已解析的值，不是 Promise（`typeof .then === "undefined"`，`await` 却能过）。修法：真实工具方法在 guest 侧包成 `async (args) => ...`（原生 Promise），`.then/.catch/Promise.all` 可用；`search/listTools/remainingCalls/services` 保持同步。写工具 stub 保持同步抛错（un-awaited 也会失败，避免静默）。新增 3 个测试，exec 描述补一句 Promise 语义 |
| BM25 对 deployments/deployment 词形与长名工具偏差，`vercel list deployments projects` 前 5 没有 `vercel__list_deployments` | **症状已不复现；两个底层建议实测不采纳（DEC）** | 当前目录下该查询 top1 就是 `vercel__list_deployments`（search 排序重构已修）。词干化实验：top1 56.5%→53.4%（-3.1）、top5 72.3%→73.8%（+1.5），且 `get deployment files` 排序被打乱；服务名 token 剔除：top1 -0.5 / top5 +0.5，是噪声。两项都不做 |
| `@cloudflare/codemode` 声明 `^0.5.6`，但 `codemode-util.js` 映射混淆单字母导出 | **已修** | package.json + package-lock 改为精确 `0.5.6`；理由：minor 升级可能重打包混淆导出，运行时静默错位。`run` 未 pin（用公开 API，不涉及混淆映射），需要时再定 |

### 2026-11-22 Gemini 探针第一轮（对话 1，线上 d4077ad）

结果：4 条读任务全部**单次 search 命中**（github/notion/linear/vercel），全程用 `execute_read`，没触发截断，也没用 `select:`。四项自评：找工具 4.5 / 写代码 4 / 结果可读性 4 / 省上下文 4.5。

| 观察 | 判断 | 处置 |
|---|---|---|
| Vercel `list_deployments({ teamId, limit: 3 })` 返回空数组 | **待证**：teamId 来源/令牌可见范围/账号确实无部署，三者之一；不是网关确定性 bug（同一调用路径下其他 Vercel 工具正常） | 已把追问卷写进 `docs/GEMINI-PROBE.md`（不带 teamId → list_projects → 按 projectId 再查 → 追 teamId 来源），等 Gemini 回报 |
| Linear issue 实际字段是 `status` / `statusType`，不是 `state?.name`；模型先用 `limit:1` 探字段才对 | 真实摩擦但不是网关 bug：上游 Linear API 的字段命名；模型自愈多花 1 次调用。风险在"静默空结果"——按错字段过滤会得到空列表，可能误答"没有数据" | 不改代码：统一返回结构要么重写上游数据（有损、破坏 raw 访问），要么维护字段映射表（易过期）。先观察下一轮是否重复出现；重复再考虑按服务的字段提示 |
| Notion 搜索第 5 条与「项目」语义不符 | 上游 `notion-search` 的模糊匹配，不是网关排序 | 不处理 |
| 4/4 单次命中、不用 `select:` | 和离线评测 top1 56.5% 不矛盾（真实查询是关键词式，比任务集口语化 prompt 好命中）；也说明"TS 类型签名"不是当前瓶颈 | 维持不做类型签名实验的优先级 |

### 2026-11-22 Gemini 探针第二轮（26 任务一次性，线上 8cce5c1～96a0de5）

执行到第 16 条后 Gemini 报"本轮工具调用次数配额已用尽"，17-21 未执行；22-26 仅给计划/拒绝，未实际调工具。

| 观察 | 判断 | 处置 |
|---|---|---|
| A 组 Vercel 空部署：实为脚本层级读错（正确路径 `r.result.deployments.deployments`），实际有 3 条 READY、4 个项目、1 个 team | **模型脚本问题，不是网关 bug**；但上游 Vercel 返回被包在 `result.*` 里，形状反直觉 | 不做通用 normalize（有损、上游各异）；记为已知形状陷阱，等指导语成本收益评估后再决定是否加一句 |
| B 组 Promise 修复：`Promise.all` / `.then` / `.catch` / `safeAll` 全部正常 | **修复在真实 Gemini 侧验证通过** | 关闭该反馈；另有一次 `d.meta?.githubCommitSha` 处报 `not a function`，需要模型贴出原始代码才能定性（纯属性读取不应抛） |
| B3 去重：`remainingCalls` 42→41→41（同参第二次不扣） | 只读去重生效 | 无需处理 |
| C 组 select：Linear 3.4-3.6k 字符、Notion update-page 6.5k+ 字符；模型明确说复杂参数不用 select 更容易填错 | **select 是复杂工具的关键路径**，不是可有可无的兜底 | 不做 TS 类型签名；观察真实使用中模型是否会主动用 select（本轮是任务要求才用） |
| D 组大结果：README 3.5k / Notion 页 12.7k 字符，均无截断标记；沙箱内过滤够用；上下文压力自评 2/5 | 符合设计 | 无需处理 |
| E 组中文/模糊搜索未执行（配额耗尽） | **空白** | 下一轮单独开对话跑 E 组 |
| F 组：PDF 导出正确说明做不了；写操作走 `execute` 且要求确认；提示词注入直接拒绝、未泄露 | 边界行为正确 | 无需处理 |

**新发现的操作约束**：Gemini 侧对**单轮**工具调用有上限（本轮措辞是"本轮工具调用次数配额已用尽"，约 16 个任务 / 20 次调用后触发；疑似单轮约 20 次，待用同一对话发"继续任务 17"验证是按轮重置还是按对话封顶）。**不是网关限制**：网关 `/mcp` 是无状态设计（`src/server.js` 每次 POST 新建 transport，无跨请求计数），唯一的上限是单次 `execute` 内 50 次工具调用，错误文本固定为 `tool call limit (50) exceeded`，本轮所有工具结果里都没有这条。以后一个对话/一轮最多放 8-10 条任务，跑完开新对话。

### 2026-11-22 Gemini 探针第三轮（中文搜索 + 追查）

**对话 2（E 组，5 条任务 / 12 次调用）**：中文查询 4/5 一次命中；纯中文 `"Vercel 运行时 错误 日志"` 没命中 `get_runtime_errors` / `get_runtime_logs`（返回 fork_drive 等无关工具），换成 `vercel runtime logs errors` 后命中。第 5 条被 Gemini 客户端预算截断，限流原文：`You have exceeded the maximum number of tool and search calls (0 remaining). Synthesize your final response to the user...` —— **Gemini 侧预算**，不是网关（网关唯一限制是单次 execute 50 次，错误文本是 `tool call limit (50) exceeded`）。

处置：**加中文查询扩展**（`src/catalog.js` 的 `CJK_SYNONYMS` + `expandCjkQuery()`）：中文域名词映射为英文 token，半权重、无 flat identifier bonus；`未合并/合并` 用最长匹配 + consumed range 防重叠，`PR/DNS/README` 只在查询含中文时展开。自建 16 条中文用例：top1 25%→88%、top5 38%→88%；英文离线 191 任务不变（56.5% / 72.3%）。新增 `tests/search-cjk.test.js`。

**对话 3（追查）**：
- `not a function` **未复现**（同一路径正常返回 `d.meta.githubCommitSha`）；按不可复现关闭，再出现再查。
- GitHub Notifications：上游工具清单里根本没有该工具（不在 deny 列表），模型正确停手——能力缺口，不是配置问题。
- `notion__notion_query_data_sources`：select 拿到 schema 后调用仍失败，原因是需要 `data:{...}` 顶层包装、`mode:"view"` 且要视图 URL（模型用了库 URL，触发 PERMISSION_DENIED）。上游参数设计问题，网关不改；select 确实减少了盲猜。
- Vercel 返回形状确认：`Object.keys(r)=["result"]`、`Object.keys(r.result)=["deployments"]`；上游 structuredContent 包装，不做通用 normalize。
- 本轮未触发配额。

**修复后的验证对话（2026-11-22，3 任务 / 7 次调用，无配额截断）**：
- `"Vercel 项目 运行时 错误 日志"` → 第 1 次 search 命中 `get_runtime_errors` + `get_runtime_logs`（修复前同义查询返回 fork_drive 等无关工具）✅
- `"Notion 搜索 页面 最近修改"` → 第 1 次命中 `notion-search` ✅
- `"Linear 查看 issue 评论"` → 第 1 次 search 没返回 `list_comments`（它排第 6，score 26.5 vs 第 5 名 34.9），换英文 `"linear list comments"` 后命中。残余：中文"查看…评论"的扩展权重不足；加权重会回归页面类查询（实测过 `查看→view/get/list` 反而更差），暂不调——模型自己换英文的成本是 1 次 search。

### 文档过期
多次出现"代码已改但文档还写旧状态"的情况（SANDBOX-SECURITY 写"真隔离未引入"但实际已引入、CONTEXT-AND-EVAL 写"Code Mode 未做"但实际早做了）。看文档结论时建议对照源码。

### 交接后的追加发现与当时的判断（2026-11-22，新窗口接手时列出）
新窗口读完后发现 6 处文档/源码不一致，当时的收口判断记录如下（供参考，不是指令）：

| 发现 | 当时的判断 | 理由 / 副作用 |
|---|---|---|
| CONTRACT.md 只覆盖 whitelist+OAuth，没有 Code Mode；但 AGENTS.md 写"契约是唯一真相" | **改 AGENTS.md 的指针，不补 CONTRACT.md** | Code Mode 还在演进（search 排序刚重构过），写进契约会僵化；Cloudflare 官方自己都标 Experimental。副作用：指令文件变更触发一次刷新，可接受 |
| AGENTS.md 写"MVP 只做本地，不实现 OAuth/DCR/Vercel"，与代码相反 | 同上，一起改 | 持续误导后续 agent |
| `src/server.js` initialize instructions 写 "two tools: search and execute"，实际注册 3 个 | **修**（改成三个或别数数） | 模型会建立错误预期。副作用：description 文字变化，已确认不需要重连 |
| UNNEEDED-TOOLS.md 写"全量放行"，实际有 deny 清单 | **修** | 后续可能据此改 config 意外放行 213 个 Vercel 工具。纯文档，低风险 |
| ledger/README.md 指向不存在的 ledger.json | 记为已知，暂不动 | 不影响正确性 |
| DEPLOY.md 仍是 whitelist 部署说明 | 记为已知，暂不动 | 不影响正确性，等真要按它部署时再修 |

另：探索 runner 读的是 `OPENCODE_GO_API_KEY`（旧 key），panel 上另有 `opencode-go-openai-key2`。当时判断先不切——"要不要再跑探索测试"本身未定，真要跑时再切一行，避免为改而改。

> 这里记录的是"当时为什么这样取舍"的过程。后续窗口若判断不同，按自己的判断走。

---

## 四、未做 / 待决策（描述现状，不替你定）

- **禁用工具清单**：当前 Vercel 禁 213/273、Notion 24/77、Linear 24/60、GitHub 4/46。最初是按"用不上"的判断禁的。Code Mode 下禁用不省上下文（工具定义不进上下文），只砍能力。**2026-11-22 用户明确：暂时不恢复，怕影响搜索面。** 以后要恢复需重新评估搜索目录和写工具面。
- **真 spill**：实测 469 次工具调用 0 次超 24k，且大结果都是模型主动 return 的沙箱结果而非单工具原始返回。当前用结构化截断 + grepSnippet 辅助。
- **search 排序**：原离线口径把 456 个 dataset 工具全量入索引（含被 deny 的 265 个），得出 top1 52.9% / top5 68.6%；按生产目录（191 个启用工具）重算为 **top1 56.5% / top5 72.3%**，已过 70%。剩余 53/191 miss 主要是纯语义/编号类（PR #123、Notion 语义、附件）。2026-11-22 判断：暂不引入 embedding（外部依赖、额度、冷启动），先修口径与零依赖查询扩展，数据不足再议。
- **金标打分**：MCPMark 的 verifier 依赖它的临时评测环境，跑不了。目前只用它做 prompt 权威性映射。
- **fetch 注入沙箱**：未做（与真隔离的网络面控制冲突）。
- **四个优化方向**（沙箱契约 / 可见性层 / 上下文预算不变量 / 真实模型冷启动回归）：曾作为方向提出，但用户未批准执行；提出时也识别了各自的副作用（见上面"副作用不说"条目）。
- **台账里"副作用分析必须写进提案"的硬规则**：用户最后说"算了"，未写入。
- **DSH 本地接入**：用户 2026-11-22 说明只是提一嘴——若做应只本地（本地 OAuth 代理），不上云，不影响 Gemini 主目标。
- **外部依赖判断权**：用户 2026-11-22 明确把外部依赖的判断交给 lead（看效果、看正负面文档，不问）。当前结论：不引入 embedding；用现有零依赖手段，数据不足再议。
- **部署校验**：已加 `GET /healthz`（commit / buildHash / mode / servers），本地用 `node scripts/write-build-info.mjs --print` 算出的 buildHash 可直接对照线上；Vercel 若未开启 System Environment Variables，commit 可能显示 dev，但 buildHash 仍能证明代码一致。

---

## 五、用户偏好（观察到的，供参考）

- 要严谨、不要空泛总结和模板化开场结尾
- 反对"给一批做一批"，要看到分析过程和判断
- 对反复授权、反复重连、低级 bug、浪费时间的行为反应强烈
- 愿意为真正有效的优化投入，但对"为了做而做"很警惕
- 会直接质疑我"确定吗""有没有副作用"——这是好事，不是找茬

---

## 最后
这份文档写于 2026-11-22，当时项目状态：286 项测试全绿，本地/仓库/线上三者同步。
它只描述当时看到的事实和判断过程。新窗口请独立判断，包括判断这份文档里哪些已经过期。
