# 上游接入与质量工作流（WORKFLOW）

> 本文件把 B0–B4 的台账、`UNNEEDED-TOOLS.md`、`CONTEXT-AND-EVAL.md` 和
> `docs/ledger/README.md` 里散落的规则收束成一条可重复执行的流程。目的只有一个：
> **新上游不许"接上就算完成"**；质量由证据和门控保证，不靠自述。
>
> 适用：新增/替换/升级任何上游（GitHub、Notion、Linear、Vercel、Figma……）。

## 0. 总览

```text
需求与优先级
  → G1 接入验证（官方文档 + 实测 + 配置校验）
  → G2 工具收口（明确用不上才 deny，存疑放行）
  → G3 场景覆盖（每个保留工具至少 1 条任务；权威等级标注）
  → G4 基线（上下文/检索/模型在环/真实调用）
  → G5 根因（表象→L1→L2→L3；修根因或 DEC）
  → G6 全量重测（当前基线、完整任务集、归因）
  → G7 交付（CI/部署/hash/凭据/台账）
```

任何一步没有证据，就停在原地，**不能进入下一步**。

## 1. 需求与优先级

- 先回答"为什么是它"：可托管？凭据可获得？工具面够大？客户端是否已有原生连接器？
  （见 `docs/ADOPTION-RANKINGS.md` 的四道筛子。）
- 明确目标用户场景：个人日常查看/管理，还是企业/团队运维；写工具是否保留。
- 不接受"榜单高就接"：榜单只是输入。

## 2. G1 接入验证

### 2.1 官方依据（先文档，后实测）

必须记录：

| 项 | 证据 |
|---|---|
| 端点 / transport | 官方文档原文 + 实测 HTTP 状态 |
| 鉴权方式 / scopes | 官方文档；必要时探测 well-known / DCR |
| token 生命周期 / refresh | 文档 + 实测（`expires_in`、refresh 响应） |
| 限流 / 套餐限制 | 官方文档；不凭记忆 |
| 工具清单来源 | `tools/list` 实测，保存 name+description |

证据规则（来自 `docs/ledger/README.md`，违反则结论不成立）：

1. 额度/配额结论逐 key 实测 + 时间戳；
2. 技术结论逐文件读源码 + 交叉验证产物；
3. 配置改动后必须跑 schema/config 校验。

### 2.2 配置与凭据

- 配置只放环境变量名，不放 secret；token 只进宿主 env/KV。
- 刷新生命周期：`tokenEnv` + `refreshEnv` + `clientIdEnv`（+ `clientSecretEnv`）+
  `refreshUrl`；provider 端点写清。
- 社区 workaround / 非官方路径必须单独标注风险，并写入 DEC。

### 2.3 注册给模型的接口

- 工具名 `server__tool`（双下划线）。
- schema 必须过 `sanitizeTool`（Gemini 约束：array 有 items、多类型收敛、oneOf 截断）。
- 带上游 annotations（readOnlyHint/destructiveHint）；`execute_read` 只读拆分依赖它。
- **工具列表稳定**：不在会话中改定义；加新上游只改沙箱内可调工具，不改外层 3 工具。

### 2.4 门控

- [ ] 官方端点/鉴权有原文 + 实测
- [ ] `node scripts/check-config.mjs` 通过
- [ ] token/refresh 走通（或静态 token 明确不过期）
- [ ] schema 过 sanitize，工具名/annotations 正确
- [ ] 没有 secret 进仓库/日志

## 3. G2 工具收口

**原则：只有"明确用不上"才 deny；"存疑"一律放行。**

1. 抓真实工具清单（name + description），不要按名字猜。
2. 三分类：
   - **明确用不上**：个人日常场景无交集 / 企业内部机制 / UI 内部辅助；
   - **存疑**：可能有用但不确定 → **放行**；
   - **保留核心**：明确要用的。
3. 写操作**不因写而删**；靠 `execute` / `execute_read` 和 annotations 区分。
4. 每个 deny 都写理由，落到 `docs/UNNEEDED-TOOLS.md` 和 `config.example.json`。
5. 记录数量：总数 / deny / 保留，和上一版对比。

> 反例（Figma，2026-11-22）：第一版按名字把 Weave/Shader/Generative plugin 共 18 个
> 标成"明确用不上"，复核官方 Tools 文档后全部放回，只保留 4 个 ChatGPT/UI 内部工具。
> **没有描述证据就不许 deny。**

门控：

- [ ] 每个 deny 有理由与来源
- [ ] 存疑项全部放行
- [ ] 写工具未被误删
- [ ] `config.example.json` 的 deny 数量与文档一致

## 4. G3 场景覆盖（B1）

- 目标：**每个保留工具至少 1 条任务**；暴露但无任务 = 0。
- 权威等级（逐级降权，如实标注）：
  1. 官方逐字 prompt / 官方文档示例；
  2. 权威 benchmark（有 prompt+评分+可复现）；
  3. schema 驱动 + 反向验证（最低，但必须 100% top-5 验证）。
- 找不到权威来源时，写清"结构性缺口"，不伪造 benchmark。
- 任务文件进入 `explore/`，记录覆盖矩阵：工具数 / 有任务数 / 缺口。

门控：

- [ ] 覆盖 100%（保留工具）
- [ ] 每条任务标权威等级
- [ ] 无黄金标准时明确登记条件通过

## 5. G4 基线

**至少四项，缺一不算完成：**

1. **上下文**：`node scripts/measure-context.mjs`，直接工具面 vs 网关 3 工具；记录 tokens/节省比例。
2. **检索**：`node scripts/eval-search.mjs`，top1/top5；必要时补中文/边界用例。
3. **模型在环**：`bench/`（假上游自检）或真实任务集；记录通过率、turn、tool calls、tokens。
4. **真实调用**：至少每个上游一个真实读调用；写工具按风险决定是否实测。

诚实要求：代理评测不等于 Gemini 真实成功率；不把离线指标当发布分数。

## 6. G5 根因修复（B2）

收到反馈/发现缺陷后，按四步：

1. **逐层**：表象 → L1 直接原因（代码行/触发条件）→ L2 设计决策 → L3 认知/假设/流程；
   修复必须作用到根因层，只压 L1 不算完成。
2. **找同类**：横向扫同源 L2/L3，不只修被反馈的那一条。
3. **收益与副作用**：每条都写"解决什么 / 引入什么风险"；模型建议尤其要检查风险。
4. **走一步看三步**：下一步会暴露什么？有没有更根本的做法？

输出：根因报告（`work/rc-*.md`）+ 修复 commit + 测试；修不动的登记 DEC（理由+影响）。

门控：

- [ ] 每条问题有 L1/L2/L3
- [ ] 真 bug 已修 + 回归测试
- [ ] 残留逐条 DEC，不隐藏欠账

## 7. G6 全量重测（B3）

- 用**当前代码基线**，完整任务集，显式列出所有上游（防止漏服务）。
- 免费模型 guard；探测器版本固定。
- 记录：任务数、异常数、归因（gateway/model/synthetic/infra）、检索召回、平均 token。
- 对每个 gateway 归因逐条判断：新功能 bug / 模型行为 / 预期行为 / 数据问题。
- 结论必须诚实："没有新功能 bug"或"有，未通过"。

## 8. G7 交付与验证

- [ ] `npm test` 全绿
- [ ] `node scripts/check-config.mjs` 通过
- [ ] CI（Node 20/22/24）全绿
- [ ] 部署后 `/healthz` 的 commit + buildHash 与本地一致
- [ ] 新上游出现在 `/healthz` servers
- [ ] 至少一次真实调用（带客户端 token）
- [ ] secret 只在宿主环境；`.vercelignore` 排除 `work/`
- [ ] 台账/文档/CHANGELOG 已更新

## 9. 台账与证据

- 分类：SCENARIO / ISSUE / ROOT / FIX / TEST / DEC（见 `docs/ledger/README.md`）。
- 每批一个 md；状态只能是 ✅通过 / ⚠️进行中 / ❌未通过。
- **没有完成 G3/G6 的上游，只能写"进行中"，不能写成"已优化"**。
- 欠账单独列，不藏在总结里。

## 10. 当前状态（2026-11-22）

| 上游 | B 批次 | 状态 | 说明 |
|---|---|---|---|
| GitHub / Notion / Linear / Vercel | B0–B3 | ✅ | 191 条任务覆盖、根因修复、全量重测；deny 4/24/24/213 |
| Figma | B4 | ⚠️ 进行中 | 接入 + 本地 E2E 完成；deny 4/50（仅 ChatGPT/UI 内部），保留 46；任务覆盖 0/46，未过 B1/B3 |
| Figma 欠账 | — | — | 20–30 条任务、measure-context/eval-search 纳入 Figma、线上真实调用、B3 式重测 |

## 11. 新增上游检查清单（可直接复制）

```text
[ ] 官方文档：端点 / transport / auth / scopes / 限流 / token 生命周期
[ ] 实测：initialize + tools/list + 一次真实读调用
[ ] 配置：tokenEnv/refresh/env 名；check-config 通过
[ ] schema：sanitize；annotations；工具名/顺序稳定
[ ] 工具清单：抓 name+description；三分类；只 deny 明确用不上
[ ] UNNEEDED-TOOLS：理由/数量/日期
[ ] 任务：每个保留工具 >=1 条；权威等级标注；覆盖 100%
[ ] 基线：measure-context / eval-search / bench / 真实调用
[ ] 根因：四步追溯；真 bug 修复 + 测试；残留 DEC
[ ] 重测：全量任务 + 归因；无新功能 bug
[ ] 交付：测试/CI/deploy/healthz hash/真实调用/secret 检查
[ ] 台账：新 B 批次 md + README 索引 + CHANGELOG
```

## 12. 相关文档

- `docs/ledger/README.md` — 批次/门控/证据规则
- `docs/UNNEEDED-TOOLS.md` — 工具裁剪依据
- `docs/CONTEXT-AND-EVAL.md` — 上下文与评测口径
- `docs/UPSTREAMS.md` — 配置字段与加新上游
- `docs/CREDENTIALS.md` — 凭据获取与风险
- `docs/ADOPTION-RANKINGS.md` — 优先级判断
- `bench/README.md` — 模型在环 harness
