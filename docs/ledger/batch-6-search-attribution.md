# B6 · 新增上游对既有检索的回归（2026-11-23）

> 触发：Figma 加入后，G4 基线发现既有 191 条任务的检索指标下降，违反
> "既有子集不得回归" 的验收标准。按 G5 四步法追溯并修复。

## 表象

| 指标 | 四上游基线 | 加入 Figma（未修） | 修复后 |
|---|---|---|---|
| 生产 catalog | 191 | 237 | 237 |
| top1（191 条） | 56.5% | 56.0%（107/191） | **57.1%**（109/191） |
| top5（191 条） | 72.3% | 71.7%（137/191） | **72.3%**（138/191） |

具体掉落：
- `create_branch`：`figma__create_new_file` 排到 GitHub `create_branch` 前（top1 丢失）。
- `issue_write`：同上（top1 丢失）。
- `notion-get-suggested-edit`：在 Notion 结果内从第 4 掉到第 6（top5 丢失）。

## 根因

- **L1**：`searchEntries` 的 IDF/avg 长度基于**全量 catalog**；新增 Figma 的 46 个工具改变了
  通用词（create/new/comments/edits）的 document frequency，既有服务内部排序随之漂移。
  同时，查询没有服务归属时，同名/近名跨服务工具互相竞争（Figma `create_new_file` vs
  GitHub `create_branch`）。
- **L2**：搜索把"服务归属"当成可选便利，而不是一等维度；新上游会改变既有排序。
- **L3**：没有"新增上游不得回归既有子集"的稳定性约束——这正是 G4 验收要拦的，但旧实现
  没有提供机制。

## 修复

1. **按服务重建索引**：一旦查询解析出 `serverFilter`（显式 `+server` / 查询中的服务名 /
   强别名），`buildIndex` 只在归属服务的 entries 上构建。IDF/avg 长度不再受其他服务增长影响。
2. **窄别名表**：`repository/repositories/repo/octocat → github`、
   `deployment/deployments → vercel`。只收强无歧义词；`issue/page/file` 等保持无过滤，
   避免隐藏同名工具；显式 `+server`/`options.server` 始终优先。
3. 回归测试：`tests/search-service-attribution.test.js`（别名、按服务稳定性、无别名不误过滤）。

## 验证

- `node scripts/eval-search.mjs`：top1 **57.1%**（109/191）、top5 **72.3%**（138/191）；
  top1 高于基线，top5 持平，**G4 既有子集不回归**。
- Figma：46 任务 top1 78.3%/top5 93.5%；schema 28/28 top-5；18 条官方任务
  top1 61.1%/top5 77.8%（官方 prompt 不含服务名，单独报告，不混口径）。
- 全量测试 343/343。

## 风险 / 副作用

- 别名是硬过滤：若用户说 "repo" 实际指其他服务，会被限定到 GitHub；只收强别名，且可用
  `+server`/显式服务名覆盖。后续新增别名必须带回归样例。
- 按服务索引改变的是"有服务归属"查询的分数；无归属查询仍用全量索引 + diversity cap。
- 该修复是通用搜索稳定性改进，不只服务 Figma。

## 状态

✅ 修复并验证；G4 既有子集达标，G5 可关闭该问题。
