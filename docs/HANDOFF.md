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
- `npm test`（本地纯单测，零成本）当前 272 项全绿
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

### 文档过期
多次出现"代码已改但文档还写旧状态"的情况（SANDBOX-SECURITY 写"真隔离未引入"但实际已引入、CONTEXT-AND-EVAL 写"Code Mode 未做"但实际早做了）。看文档结论时建议对照源码。

---

## 四、未做 / 待决策（描述现状，不替你定）

- **禁用工具清单**：当前 Vercel 禁 213/273、Notion 24/77、Linear 24/60、GitHub 4/46。最初是按"用不上"的判断禁的。Code Mode 下禁用不省上下文（工具定义不进上下文），只砍能力。用户尚未逐个确认要不要放行。
- **真 spill**：实测 469 次工具调用 0 次超 24k，且大结果都是模型主动 return 的沙箱结果而非单工具原始返回。当前用结构化截断 + grepSnippet 辅助。
- **search 排序**：重构后离线 top1 48.2%→52.9%、top5 60.2%→68.6%，未达 70%。剩余失败是纯语义无词面重叠，需要 embedding 才能突破（未做）。
- **金标打分**：MCPMark 的 verifier 依赖它的临时评测环境，跑不了。目前只用它做 prompt 权威性映射。
- **fetch 注入沙箱**：未做（与真隔离的网络面控制冲突）。
- **四个优化方向**（沙箱契约 / 可见性层 / 上下文预算不变量 / 真实模型冷启动回归）：曾作为方向提出，但用户未批准执行；提出时也识别了各自的副作用（见上面"副作用不说"条目）。
- **台账里"副作用分析必须写进提案"的硬规则**：用户最后说"算了"，未写入。

---

## 五、用户偏好（观察到的，供参考）

- 要严谨、不要空泛总结和模板化开场结尾
- 反对"给一批做一批"，要看到分析过程和判断
- 对反复授权、反复重连、低级 bug、浪费时间的行为反应强烈
- 愿意为真正有效的优化投入，但对"为了做而做"很警惕
- 会直接质疑我"确定吗""有没有副作用"——这是好事，不是找茬

---

## 最后
这份文档写于 2026-11-22，当时项目状态：272 项测试全绿，本地/仓库/线上三者同步。
它只描述当时看到的事实和判断过程。新窗口请独立判断，包括判断这份文档里哪些已经过期。
