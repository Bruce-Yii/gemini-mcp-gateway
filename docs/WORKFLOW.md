# 上游接入与质量工作流（完整版）

> 文档状态：**REVIEW CANDIDATE** · 版本 v1.0 · 日期 2026-11-22
> 维护者：项目 lead（Gemini MCP Gateway）
> 审核对象：独立窗口/评审人。本文档是自包含的：不依赖聊天上下文，按文中的命令和证据路径即可复核。
>
> 目标：把"接一个新上游"从一次性手工劳动，变成**有门控、有证据、可复跑、可审计**的流水线。
> 任何上游只有走完 G1–G7 并且全部验收项通过，才可以标记为"已优化/已交付"。

---

## 0. 给审核窗口的阅读指南

审核时请优先回答这些问题：

1. 每道门的验收标准是否**可测量/可复现**，而不是"看起来做了"？
2. 每道门是否有明确的**证据产物路径**和命令？换一个人能否独立复核？
3. 当前状态（第 12 节）是否**诚实**——尤其是 Figma B4 的欠账，有没有被写成"已完成"？
4. G2 工具收口是否允许"按名字猜 deny"？Figma 的误伤教训有没有被制度化？
5. G3 的覆盖口径是否会在新增上游时被"混口径"抬高/拉低指标？G4 的对比是否同子集？
6. G5/G6 是否能把"网关 bug"与"模型行为/数据问题/infra"分开，避免假通过？
7. 凭据、社区 workaround、本地依赖、限流等风险是否都有 fallback 和 DEC 记录？
8. 是否存在**未被本文覆盖**的重复性工作？如果有，应该补成脚本/模板。

审核结论建议只写三种：**通过 / 有条件通过（列条件） / 不通过（列缺口）**。

---

## 1. 质量模型与原则

### 1.1 三个质量维度

| 维度 | 定义 | 反面 |
|---|---|---|
| **上下文经济** | 挂载时工具定义少、调用时结果可控、模型不被无关上下文淹没 | 456 个工具全量注入；一次调用灌 1900 tokens |
| **准确性** | 每个暴露工具都有可复现场景覆盖；检索能命中；真实调用成功 | 自造评测、假 gold、把模型行为算成网关 bug |
| **可信交付** | 配置可校验、部署可验证、秘密不外泄、结论有证据 | "我跑过了"、只改文件不校验、伪造 benchmark |

### 1.2 五条硬原则

1. **证据优先**：结论必须能落到文件/命令输出/时间戳；不接受自述。
2. **门控串行**：G1→G2→…→G7，前一道不通过不进下一道；**门内可批量/并行**，不需要逐工具手工操作。
3. **明确才 deny**：工具收口只有"明确用不上"才拒绝，"存疑"一律放行；写操作不因写而删。
4. **修根因**：问题必须追到 L2/L3；只修 L1 表象不算完成；残留登记 DEC，不隐藏。
5. **诚实标注**：指标是"找问题基线"还是"发布分数"必须写清；结构性缺口不伪造成"通过"。

### 1.3 状态图例

| 状态 | 含义 | 使用条件 |
|---|---|---|
| ✅ | 通过 | 该门全部验收项满足，证据齐全 |
| ⚠️ | 进行中 | 已开始/部分满足，仍有关键项未完成 |
| ❌ | 未通过 | 关键项失败，或无法复现 |
| DEC | 已接受的残留 | 有理由、有影响说明、有人负责 |
| — | 不适用 | 上游不具备该能力，需说明 |

---

## 2. 角色与职责

| 角色 | 职责 | 不做什么 |
|---|---|---|
| **Lead（执行代理）** | 执行 G1–G7、写脚本/测试、跑评测、维护台账、部署验证 | 不伪造评测、不把模型行为归因成网关 bug |
| **Subagent（研究/审计）** | 查官方文档、交叉验证端点/鉴权、独立复核清单 | 只允许使用约定的免费模型；结论必须带来源 |
| **User（产品所有者）** | 决定优先级、凭据/授权、真实 Gemini 会话验证、对"存疑工具"拍板 | 不需要逐工具抄任务；不需要手工跑重复命令 |
| **Reviewer（旧窗口）** | 审文档/门控/证据、指出缺口、给通过/有条件通过/不通过 | 不直接改生产配置 |

---

## 3. 产物与目录

```text
docs/
  WORKFLOW.md                 ← 本文档（总流程 + 验收标准 + 模板）
  ledger/
    README.md                 ← 批次/门控/证据规则/反馈机制
    batch-0-history.md        ← 历史修复
    batch-1-scenario.md       ← 场景覆盖门
    batch-2-rootcause.md      ← 根因修复门
    batch-3-retest.md         ← 全量重测门
    batch-4-figma.md          ← Figma B4（进行中，含欠账）
  UNNEEDED-TOOLS.md           ← 工具收口依据（含 Figma 纠错记录）
  CONTEXT-AND-EVAL.md         ← 上下文/评测口径与历史
  WHY.md                      ← 问题动机、实测数据
  UPSTREAMS.md                ← 配置字段、加新上游
  CREDENTIALS.md              ← 凭据获取、workaround、风险
  ADOPTION-RANKINGS.md        ← 优先级四道筛子
  CLIENTS.md                  ← 客户端兼容矩阵
config.example.json           ← 生产配置（含 deny/refresh 字段）
tests/                        ← 单元/集成/回归
scripts/                      ← check-config / eval-search / measure-context / ...
bench/                        ← 模型在环 harness（假上游自检）
explore/                      ← 任务集与探索结果
work/                         ← 本地 scratch、根因报告、临时 token（git-ignored）
```

**秘密规则**：`work/` 永远不入库、不上传 Vercel（`.vercelignore` 排除）；token 只进宿主 env/KV；日志不打印 token。

---

## 4. 生命周期总览

```text
Phase 0  需求/优先级（ADOPTION-RANKINGS 四道筛子）
   │
G1 接入验证 ──官方文档 + 实测 + 配置/鉴权/schema
   │
G2 工具收口 ──真实 name+description → 明确/存疑/核心 → deny 仅明确项
   │
G3 场景覆盖 ──每个保留工具 ≥1 任务；权威等级；100% 覆盖
   │
G4 基线 ─────上下文 / 检索 / 模型在环 / 真实调用
   │
G5 根因修复 ──表象→L1→L2→L3；同类扫描；收益/风险；回归测试
   │
G6 全量重测 ──当前基线 + 完整任务集；gateway 新功能 bug=0
   │
G7 交付 ─────测试/CI/部署/hash/真实调用/秘密/文档/台账
```

**门内批量原则**：G3 一次生成全部任务并跑覆盖矩阵；G4 一次跑完所有指标；G6 一次跑完整任务集。只有**门与门之间**必须串行。

---

## 5. Phase 0：需求与优先级

### 输入
- 候选上游、用户目标、官方 MCP 文档、采用数据（`ADOPTION-RANKINGS.md`）。

### 四道筛子
1. **可托管**：远程/本地？本地浏览器、本地文件系统类不作为托管网关目标。
2. **客户端是否已有原生连接器**：有则说明差异化价值，不重复造。
3. **工具面价值**：工具数量/复杂度是否足以让 Code Mode 产生上下文收益。
4. **凭据可获得性**：静态 token、OAuth、DCR/allowlist；用户能否合法获得。

### 产物
- 决策记录（DEC）：做/不做、替代方案、风险。
- 预估算力/维护成本。

---

## 6. G1：接入验证

### 步骤

1. **官方证据**：端点、transport、鉴权方式、scopes、限流、token 生命周期；附 URL 和原文。
2. **实测探测**（带时间戳）：
   - 未认证请求 → 期望 401 + `WWW-Authenticate`；
   - `initialize` → `tools/list`，保存 name+description；
   - 必要时探测 well-known / DCR / token endpoint。
3. **配置与凭据**：
   - `tokenEnv` / `refreshEnv` / `clientIdEnv` / `clientSecretEnv` / `refreshUrl`；
   - 静态 token 写清是否长期有效；refresh 强刷一次并确认持久化/轮换；
   - 无效 grant / needsReauth 的行为要明确。
4. **schema 与接口**：
   - `sanitizeTool` 全过（array items、多类型、oneOf 深度）；
   - 工具名 `server__tool`；annotations 透传；
   - 工具列表稳定（会话中不改定义）。
5. **真实调用**：至少一个读工具返回真实数据；写工具按风险决定是否实测。

### 验收标准（DoD）

| # | 标准 | 证据/命令 |
|---|---|---|
| 1.1 | 官方端点/鉴权/限流有原文 | 文档链接 + 摘录 |
| 1.2 | initialize + tools/list 成功，工具数记录 | 输出 + 时间戳 |
| 1.3 | schema sanitize 0 失败 | 启动日志/测试 |
| 1.4 | config 校验通过，secret 不在仓库/日志 | `node scripts/check-config.mjs` |
| 1.5 | token 生命周期/刷新实测 | 强刷记录（不打印 token） |
| 1.6 | 至少一次真实读调用 | 返回结果/URL |
| 1.7 | **tools/list 快照已入库** `data/tool-snapshots/<server>.json`，且 live `tools/list` 与快照一致 | 快照文件 + `node scripts/audit-tools.mjs --server <name> --write-snapshot` 重放 |

**门禁：以上全满足才进入 G2。**

---

## 7. G2：工具收口

### 分类规则

| 分类 | 判定 | 处理 |
|---|---|---|
| **明确用不上** | 个人日常场景无交集 / 企业内部机制 / UI 内部辅助 / 与目标客户端无关 | deny |
| **存疑** | 可能有用但证据不足 | **放行** |
| **保留核心** | 明确目标能力 | 放行 |
| 写操作 | 不因"是写"而 deny | 放行，靠 `execute`/`execute_read`/annotations 区分 |

### 步骤

1. 抓 `tools/list` 的 **name + description**（不按名字猜）。
2. 逐项分类，写理由与来源；对照官方 Tools 文档。
3. 更新 `config.example.json` 的 `denyTools`；更新 `UNNEEDED-TOOLS.md`（数量/理由/日期）。
4. 做一次 **误伤审计**：
   - 官方工具清单里有的，是否被误 deny？
   - 写工具是否被误删？
   - 存疑项是否被当成明确项？
5. `check-config` 确认 deny 数量；必要时跑 `eval-search` 确认不回归。

### 验收标准

| # | 标准 | 证据 |
|---|---|---|
| 2.1 | 保留 + deny = 总数，无漏项 | 清单 + 脚本 |
| 2.2 | 每个 deny 有类别/理由/官方依据 | `UNNEEDED-TOOLS.md` |
| 2.3 | 存疑全部放行；写工具未被仅因写而删 | 对照表 |
| 2.4 | config/文档/台账三处数量一致 | `check-config` 输出 |
| 2.5 | 既有搜索指标不回归 | `eval-search` |
| 2.6 | **deny 对照脚本通过**：官方清单 vs snapshot vs deny 自动 diff，无"无理由 deny"/"存疑 deny"/未声明 extra | `node scripts/audit-tools.mjs --server <name>` |
| 2.7 | `check-config` 能显示 `total/exposed/denied`，不依赖本地缓存或 token | `node scripts/check-config.mjs` |

**反面案例（已纠正）**：Figma 第一版按名字 cut 22 个，其中 18 个是官方 Weave/Shader/Generative plugin 工具；复核官方 Tools 文档后放回，最终 deny 4 个 ChatGPT/UI 内部工具，保留 46。规则：**没有描述/官方依据，不许 deny**。

### 评审整改（2026-11-22，conditional pass）

评审指出两条必须升格为 DoD，已落实：

| 条件 | 整改 | 状态 |
|---|---|---|
| 证据必须入库、换人可复核 | `data/tool-snapshots/<server>.json` 入库；`check-config` 输出 `total/exposed/denied`；`data/tool-dataset.json` 同步 | ✅ 四个旧上游 + Figma 50 快照均入库；Figma 50/46/4 可复核 |
| deny 对照脚本化 | `scripts/audit-tools.mjs` + `data/official-tools/figma.json` + `data/tool-policy/figma.json`；任何 deny 必须有显式类别/理由，extra 必须声明 | ✅ 脚本 + 单测 + Figma audit exit 0；缺快照时按设计 exit 2 |

---

## 8. G3：场景覆盖（B1）

### 目标
每个**保留工具**至少 1 条可复现任务；暴露但无任务 = 0。

### 任务文件格式（建议）

```json
{
  "id": "figma-create-file",
  "server": "figma",
  "tools": ["create_new_file"],
  "prompt": "用 Figma 创建一个空白设计文件，叫 Workflow Test。",
  "authority": "official-verbatim | benchmark | schema-reverse",
  "source": "https://help.figma.com/hc/en-us/articles/42495147242903",
  "preconditions": ["Figma token valid", "有可用 planKey"],
  "checks": [{ "type": "contains", "value": "file_key" }],
  "cleanup": "delete test file if API supports"
}
```

### 权威等级

1. **官方逐字**：官方文档/示例 prompt 原文（100% 可信来源）。
2. **权威 benchmark**：有 prompt + 评分 + 可复现；标注来源与限制。
3. **schema 驱动 + 反向验证**：由 schema 生成，必须 100% 通过 top-5 反向验证。
4. 无权威来源：写明结构性缺口，不能伪造 benchmark。

### 步骤

1. 从官方文档提取示例 prompt；从 schema 生成补充任务。
2. 覆盖矩阵：工具 → 任务；脚本检查每个保留工具至少 1 条。
3. 悬空引用检查：任务指向的工具必须存在、未被 deny。
4. 反向验证：schema 任务 top-5 全通过。
5. 任务按上游分组，记录权威占比。

### 验收标准

| # | 标准 | 证据 |
|---|---|---|
| 3.1 | 覆盖 100%（每个保留工具 ≥1 任务） | 覆盖矩阵 |
| 3.2 | 0 悬空引用/0 denied 工具任务 | 覆盖脚本 |
| 3.3 | 每条任务有权威等级与来源 | 任务文件 |
| 3.4 | schema 任务 top-5 100% | 验证输出 |
| 3.5 | 缺口写明结构性原因 | 台账 |

**门禁：未达 100% 不许进 G4。**

---

## 9. G4：基线

### 9.1 上下文
- `node scripts/measure-context.mjs`：直接工具面 vs 网关 3 工具。
- 记录：工具数、tokens、节省比例；新上游必须纳入统计。
- 注意：统计必须是真实 schema，不用估算。

### 9.2 检索
- `node scripts/eval-search.mjs`：top1/top5。
- **同子集对比**：既有任务子集不得低于基线（当前英文 56.5/72.3）；新上游任务单独报告，不混口径。
- 中文/边界用例单独列。

### 9.3 模型在环
- `bench/`：固定任务、模型、轮次；记录通过率、turns、tool calls、tokens。
- 自检假上游与真实上游分开报告；免费模型 guard。

### 9.4 真实调用
- 每个上游至少一次真实读调用；Figma 至少真实建一次文件。
- 写操作按风险决定；产生外部状态的要记录清理方式。

### 验收标准

| # | 标准 | 证据 |
|---|---|---|
| 4.1 | 上下文指标含新上游，真实 schema | `measure-context` 输出 |
| 4.2 | 既有子集检索不回归；新增子集单独报告 | `eval-search` + 对比表 |
| 4.3 | 模型在环结果可复现 | `bench/` 结果 |
| 4.4 | 每个上游真实读调用；Figma 建文件 | 返回结果/URL |

---

## 10. G5：根因修复（B2）

### 四步法

1. **逐层**：表象 → L1 直接原因（代码行/触发条件）→ L2 设计决策 → L3 认知/假设/流程。
2. **找同类**：横向扫同源 L2/L3；不只修被反馈的那一条。
3. **收益与风险**：每条修复写"解决什么 / 引入什么副作用 / 下一步会暴露什么"。
4. **修根因**：修复作用在 L2/L3；修不动登记 DEC（理由/影响/负责人）。

### 问题归因分类
- gateway 功能性 bug
- 模型行为
- 上游数据/占位符
- 基础设施/环境
- 预期行为（例如 execute_read stub 拒绝写工具）

### 验收标准

| # | 标准 | 证据 |
|---|---|---|
| 5.1 | 每条问题有 表象→L1→L2→L3 | 根因报告 |
| 5.2 | 同类扫描已做 | 报告 |
| 5.3 | 收益/风险/副作用/下一步已写 | 报告/台账 |
| 5.4 | 真 bug 有回归测试 | 测试 |
| 5.5 | 无未处理 gateway 功能性 P0/P1 | 台账 |

---

## 11. G6：全量重测（B3）

### 规则
- 当前代码基线；完整任务集；显式列出所有上游（防漏服务）。
- 免费模型 guard；探测器/框架版本固定。
- 记录：任务数、完成率、异常数、归因（gateway/model/synthetic/infra）、检索召回、平均 token。
- 对每个 gateway 归因逐条判断：新功能 bug / 模型行为 / 预期行为 / 数据问题。

### 验收标准

| # | 标准 | 证据 |
|---|---|---|
| 6.1 | 当前基线 + 完整任务集 + 全上游 | 运行记录 |
| 6.2 | 完成率 100%（除登记 skip）；异常全归因 | 汇总 |
| 6.3 | gateway 新功能 bug = 0 | 逐条分析 |
| 6.4 | 与 G4 基线对比，下降有解释 | 对比表 |
| 6.5 | 结论只能是"通过/未通过" | 台账 |

---

## 12. G7：交付

### 验收标准

| # | 标准 | 证据 |
|---|---|---|
| 7.1 | `npm test` 全绿；`check-config` 通过 | 输出 |
| 7.2 | CI Node 20/22/24 全绿 | GitHub Actions |
| 7.3 | `/healthz` commit + buildHash 与本地一致；servers 含新上游 | curl |
| 7.4 | 一次带客户端 token 的真实调用成功 | 调用记录 |
| 7.5 | secret 只在宿主；`.vercelignore` 排 `work/`；无日志泄漏 | 检查 |
| 7.6 | WORKFLOW/UNNEEDED/CREDENTIALS/ledger/CHANGELOG 同步 | diff |

### 回滚/降级
- 每个上游必须有降级方案（Figma：Framelink PAT 只读 / 桌面 server；其他：静态 token / 直连）。
- 部署失败或线上异常 → 回滚到上一个 `/healthz` 通过且 buildHash 已知的 commit。

---

## 13. 台账协议

### 分类
`SCENARIO` / `ISSUE` / `ROOT` / `FIX` / `TEST` / `DEC`。

### 批次
一个上游或一次大改 = 一个 B 批次 md；README 表格索引；状态 ✅/⚠️/❌。
**没有完成 G3/G6 的上游只能写"进行中"。**

### 每条记录必须包含
- 编号（如 `B4-FIX-01`）
- 内容（一句话）
- 证据（文件/命令/commit/时间戳）
- 状态
- 影响/风险（如适用）

### 证据规则（不可违反）
1. 配额/限流结论逐 key 实测 + 时间戳；
2. 技术结论逐文件读源码 + 交叉验证产物；
3. 配置改动后必须跑 schema/config 校验。

### 决策（DEC）模板
```text
DEC-B4-01: 接受 Figma OAuth allowlist workaround
理由：官方远程仅对目录 client 开放；用户要求完整功能
风险：Figma 可随时封禁；非官方支持
Fallback：Framelink PAT（只读）/ 桌面 server / 等待目录开放
状态：已接受
```

---

## 14. 指标定义（避免口径漂移）

| 指标 | 定义 | 备注 |
|---|---|---|
| 工具面 tokens | 所有注册工具 definition 的 token 总量 | 用实际 schema |
| 网关 tokens | 3 个 Code Mode 工具的 definition 总量 | 不含上游内部 |
| 节省比例 | 1 − 网关/工具面 | 仅挂载时 |
| searchHitRate | 期望工具在 top-k 命中的任务比例 | 注明任务集 |
| top1/top5 | 期望工具排名第 1/前 5 的比例 | 英文/中文分开 |
| 模型在环通过率 | 任务 checks 全部通过的比例 | 注明模型/轮次 |
| gateway 归因 | 最终判定为网关问题的异常数 | 必须逐条复核 |
| 真实调用 | 非模拟上游返回的真实数据 | 记录时间/服务 |

**禁止**：把新增上游任务混进旧基线拉高/拉低整体分数；把代理模型指标当 Gemini 成功率；把模型行为算成网关 bug。

---

## 15. 风险登记与例外

| 风险 | 影响 | 缓解/决策 |
|---|---|---|
| Figma OAuth allowlist workaround | 非官方，随时可能失效 | DEC 明确；降级 Framelink PAT/桌面；不用于关键依赖 |
| Vercel 敏感 env 不可拉取 | 本地无法复用线上 token | 本地需要一次重新授权；G4 前执行 |
| 本地-only server（Figma 桌面/插件桥） | 托管网关不可用 | 明确标记 local-only；不纳入 hosted 验收 |
| 上游工具/接口变更 | deny/任务失效 | 升级后重跑 G2–G6；工具清单快照 |
| 限流/套餐限制 | 评测失败/成本 | 官方文档 + 实测；评测用免费/低额度路径 |
| 秘密泄漏 | 账号风险 | env/KV、`.vercelignore`、日志脱敏、定期轮换 |
| 评测 gold 错误 | 假通过 | 权威等级标注；schema 反向验证；不自造 benchmark |

---

## 16. 维护与再审计触发条件

出现以下任一情况，重跑对应门：
- 上游 `tools/list` 变化（新增/删除/改 schema）→ G2、G3、G4；
- token/refresh 失败或 provider 改 auth → G1；
- 线上真实调用异常 → G5、G6；
- 依赖/运行时升级（Node、SDK、Vercel runtime）→ G6、G7；
- 用户反馈准确性问题 → G5 四步法。

---

## 17. 当前状态（2026-11-22）

| 上游 | 批次 | 状态 | 关键事实 |
|---|---|---|---|
| GitHub | B0–B3 | ✅ | deny 4；42 暴露；191 条任务覆盖 |
| Notion | B0–B3 | ✅ | deny 24；53 暴露；refresh/CAS 修复 |
| Linear | B0–B3 | ✅ | deny 24；36 暴露；无权威 benchmark（结构性缺口已登记） |
| Vercel | B0–B3 | ✅ | deny 213；60 暴露；平台 API 噪音大 |
| Figma | B4 | ✅ 通过 | 50 工具；deny 4；保留 46；G1–G7 全部通过 |

### Figma B4 逐门状态

| 门 | 状态 | 说明 |
|---|---|---|
| G1 | ✅ | 接入/实测/config ✅；tools/list 快照入库；token 强刷实测并同步 Vercel；真实建文件 ✅ |
| G2 | ✅ | deny 4（ChatGPT/UI 内部）+ policy/审计脚本；audit-tools exit 0（50/46/4） |
| G3 | ✅ | 46/46 任务覆盖；18 official / 28 schema；schema 28/28 top-5；9 个 Weave 任务按账号原因 skip |
| G4 | ✅ | 506 工具 245,377 tokens vs 3 工具 1,481（-99.4%）；既有 191 条 top1 57.1/top5 72.3（B6 修复后）；Figma schema 28/28 |
| G5 | ✅ | B6 修复新增上游导致的检索回归（按服务索引 + 窄别名）；无其它 Figma 根因 |
| G6 | ✅ | 修复 Intl+detector 后重跑 228 任务/5 上游；anomalies 363，gateway 86 逐条复核无新功能 bug；详见 B7 |
| G7 | ✅ | Gemini 线上真实调用：Vercel 项目/部署 READY；Figma whoami + pages 成功；无错误 |
| G8 | — | 不适用（Figma 无额外 G8 门） |

### 已知欠账
1. 仓库 README 引用的 `ledger.json`（机器可读总账）当前不存在；需确认是否补建/删除引用。

---

## 18. 审核清单（Reviewer 用）

- [ ] 每道门的验收项是否可测量、可复现？
- [ ] 是否有证据路径/命令，换人能否复核？
- [ ] G2 是否禁止按名字猜 deny？Figma 纠错是否被记录？
- [ ] G3 是否要求 100% 覆盖、悬空引用=0、权威等级标注？
- [ ] G4 是否同子集对比、新增任务单独报告？
- [ ] G5 是否要求 L1–L3、同类扫描、收益/风险、回归测试？
- [ ] G6 是否要求全上游、全任务、gateway 新 bug=0、归因逐条？
- [ ] G7 是否包含 CI/deploy/hash/真实调用/秘密检查？
- [ ] 当前状态是否诚实标注 Figma B4 为⚠️？
- [ ] 风险/fallback/DEC 是否完整？
- [ ] 是否存在未自动化的重复劳动？建议补哪些脚本？

**审核输出格式**：
```text
结论：通过 / 有条件通过 / 不通过
条件/缺口：
1. ...
2. ...
建议：
1. ...
```

---

## 19. 附录 A：新增上游执行清单

```text
[ ] Phase 0：四道筛子 + DEC
[ ] G1：官方原文 / initialize+tools/list / config / schema / token 强刷 / 真实读
[ ] G2：name+description / 三分类 / deny 理由 / 误伤审计 / check-config
[ ] G3：任务集 / 覆盖矩阵 100% / 悬空=0 / 权威等级 / 反向验证
[ ] G4：measure-context / eval-search（同子集） / bench / 真实调用
[ ] G5：L1-L3 / 同类扫描 / 收益/风险 / 回归测试 / DEC
[ ] G6：全量重测 / 全上游 / 归因 / gateway 新 bug=0
[ ] G7：npm test / check-config / CI / healthz hash / 真实调用 / secret / docs/ledger
```

## 20. 附录 B：常用命令

```bash
npm test
node scripts/check-config.mjs config.example.json
node scripts/audit-tools.mjs --server figma
node scripts/audit-tools.mjs --server figma --write-snapshot --sync-dataset
node scripts/eval-search.mjs
node scripts/measure-context.mjs
node bench/run.mjs --dry-run
node scripts/write-build-info.mjs --print
curl -s https://<domain>/healthz
npm run smoke
```

## 21. 附录 C：术语

- **B1/B2/B3**：台账中的场景门、根因门、重测门。
- **Code Mode**：只用 `search`/`execute_read`/`execute` 三个工具，脚本在沙箱里调上游。
- **DENY/ALLOW**：config 中的工具黑/白名单；本项目主要用 deny。
- **DEC**：决策记录（做/不做/接受风险）。
- **DoD**：验收标准（Definition of Done）。
- **同子集对比**：只比较相同任务集合的指标，避免新增任务改变口径。
