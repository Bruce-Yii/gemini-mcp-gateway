# Deployment policy — 少部署、批量部署

> 目的：避免“改一点就部署”烧掉 Vercel 100 deployments/day。
> 默认目标：**每天 ≤ 3 次生产部署**；没有硬需求就不部署。

## 1. 不触发部署的改动

以下只跑本地/CI，不部署：

- 文档、README、AGENTS、ledger、eval 报告；
- 纯测试、fixture、harness；
- 注释、类型、格式；
- 只影响 OSS 导出/本地脚本的改动；
- 尚未完成、还在中间态的修复。

## 2. 可以部署的批次

一次部署只在一个**完整批次**结束时发生：

- 运行时行为变化（`src/`、`api/`、配置 schema）；
- 全量 `npm test` 0 fail；
- `audit-truncation --ci` PASS；
- 本地/回放验证通过（`local-e2e-verify`、必要的 replay/L1）；
- 工作树干净、commit 已推送；
- 明确这次部署要验证什么（一个或多个 acceptance 门）。

## 3. 部署前检查

```text
[ ] git status 干净
[ ] git log 一条部署 commit
[ ] npm test 0 fail
[ ] audit-truncation --ci PASS
[ ] local-e2e-verify PASS
[ ] 这次部署对应的 acceptance gate 明确
[ ] 不是 docs/tests-only
```

## 4. 部署频率

- 默认：每天 ≤ 3 次；
- 同一小时内不重复部署；
- 小改动攒批；
- 紧急 hotfix 例外，但必须在部署日志记录原因；
- 预览部署不算“免费”，能本地验证就不发 preview。

## 5. 部署后立即验证

- `GET /healthz`：commit/buildHash 匹配；
- `/mcp` 401 challenge；
- 必要的真实路径（按本次目标）；
- 记录到 `docs/DEPLOYMENTS.md`（commit、时间、目的、结果）。

## 6. 回滚

- 保留上一个稳定 deployment URL；
- 生产别名可切回；
- 回滚不重新部署旧 commit，除非别名切换不可用；
- 回滚后仍要跑 healthz + 401。

## 7. 当前状态

- 生产：`87d91af`（2026-11-24 部署，验收门 A PASS）；
- 下一次部署：等下一个完整批次，不为单点改动部署；
- 当前不部署。
