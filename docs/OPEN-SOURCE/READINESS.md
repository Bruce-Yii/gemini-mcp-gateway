# Open-source readiness — 开源要做到什么程度

> 结论先说：**“代码能公开”与“开源项目可用”不是一回事。**
> 本项目涉及上游凭据、真实写入、OAuth 授权、full-fidelity capture，公开门槛应高于普通工具库。
> 当前状态：**未达到可公开发布的最低线**。

---

## 1. 四个开源等级

| 等级 | 名称 | 能公开什么 | 不能宣称什么 |
|---|---|---|---|
| **L0** | source-available alpha | 源码、README、许可证、CI、基本测试 | 不能宣称“可自托管”“支持某客户端” |
| **L1** | usable alpha | 一个真实客户端端到端可用；真实读/写/授权至少一条路径验证；Docker/安装可复现 | 不能宣称多客户端、生产级、安全审计完成 |
| **L2** | maintainable beta | 多客户端/多上游；稳定 API；贡献流程；安全策略；版本/发布 | 不能宣称零运维、企业级 |
| **L3** | production-ready | SLO、迁移/回滚、安全响应、依赖治理、长期维护承诺 | — |

本项目合理目标：

- **首发 L1 usable alpha**，不是 L3；
- 但 **L0 也不能跳过**；
- 多客户端/多上游是 L2，不是首发门槛。

---

## 2. 最低公开发布线（必须全过）

### G0 法律与身份

- [ ] LICENSE 明确（MIT/Apache-2.0）；
- [ ] 第三方依赖许可证审计；
- [ ] 无个人 handle、真实邮箱、真实域名、内部仓库名、绝对本地路径；
- [ ] package/repo/README 身份统一；
- [ ] 无 token/secret/API key（含转义/URL 编码形式）。

### G1 可复现构建

- [ ] 干净 clone 后 `npm ci` 成功；
- [ ] `npm test` 0 fail；
- [ ] 无私有 fixture 依赖；缺 fixture 必须显式 SKIP 并说明；
- [ ] `audit-truncation --ci` P0=0；
- [ ] `check-config` 通过；
- [ ] CI 在干净仓库首推绿。

### G2 真实端到端

至少一个真实客户端/真实上游链路：

- [ ] Gemini web 真实任务：读文件、PR number、大文件截断；
- [ ] 真实写回环：read→patch→commit→PR→CI；
- [ ] 写后字节对账，失败无半成品；
- [ ] 有 exact tool call/args/actual/requestId 证据。

### G3 文档与承诺一致

- [ ] README 的能力声明有证据；
- [ ] 不支持的能力明确写“不支持/实验”；
- [ ] 快速开始、配置、认证、部署、限制；
- [ ] Docker 运行方式与 healthcheck 一致；
- [ ] 不把测试绿写成“生产可用”。

### G4 授权与安全

- [ ] 网关独立授权，不与 DSH 共享 refresh token；
- [ ] 未标记 grant 不自动 refresh；
- [ ] 模型可见错误不泄漏 token；
- [ ] capture full-fidelity，并在文档中明确隐私边界；
- [ ] 入站 OAuth issuer/resource/client_id 一致；
- [ ] preview/production KV 隔离；
- [ ] 依赖漏洞有结论（`npm audit` 或替代）。

### G5 打包与部署

- [ ] Docker build + run + healthz；
- [ ] Vercel/Docker/本地至少两种载体文档；
- [ ] 环境变量清单无秘密；
- [ ] 部署/回滚说明；
- [ ] 版本号、release notes、tag。

### G6 社区与维护

首发可后置，但公开前至少准备：

- [ ] CONTRIBUTING；
- [ ] SECURITY.md；
- [ ] Issue/PR 模板；
- [ ] 行为准则；
- [ ] 支持范围/路线图；
- [ ] 问题分级与响应预期。

---

## 3. 当前状态对照

| 门 | 状态 | 说明 |
|---|---|---|
| G0 法律/身份 | **部分** | neutralizer 已修；LICENSE/package identity 部分；release notes/tag 未定 |
| G1 可复现构建 | **部分** | staging 0 fail，但 117 个 skip、私有 fixture 依赖、CI 首推未完全干净 |
| G2 真实端到端 | **未过** | 真实客户端/真实写/真实授权未验收 |
| G3 文档一致 | **未过** | 文档曾出现旧构建/旧数字；部分已修，仍需全量复核 |
| G4 授权/安全 | **未过** | owner 未完全落地；origin/KV 仍在修；npm audit/Docker 未验 |
| G5 打包/部署 | **部分** | Vercel 可跑；Docker build 未验；release notes/tag 未定 |
| G6 社区 | **未做** | 无 CONTRIBUTING/SECURITY/模板 |

**结论：不能公开发布。**

---

## 4. 推荐首发形态

不要一上来做“通用 MCP 网关”：

- 定位：**Gemini web 的 Code Mode 网关（alpha）**；
- 支持：GitHub 优先；Notion/Linear/Vercel 标 experimental；
- 形态：Docker + Vercel + 本地；
- 明确限制：
  - 单 owner/单租户；
  - 不承诺多客户端；
  - 不承诺生产级 SLA；
  - 不承诺所有上游工具；
  - capture 含敏感数据，用户需自担存储安全。

---

## 5. 发布前最后一页清单

```text
[ ] 干净 clone → npm ci → npm test 0 fail（无私有 fixture）
[ ] Docker build + run + healthz
[ ] Gemini 真实 3 任务
[ ] 真实写回环（一次性测试仓库）
[ ] 网关独立授权（至少 Linear 或 Notion）
[ ] origin/KV 隔离
[ ] 安全审计结论
[ ] 无个人/内部数据
[ ] LICENSE/README/快速开始/限制
[ ] CONTRIBUTING/SECURITY/Issue 模板
[ ] release notes + tag
```

全过才叫 **L1 usable alpha**。

---

## 6. 一句话

**开源不是把代码推上去；是让陌生人在干净环境里能复现、能跑通一条真实链路、知道边界、出了安全问题有地方报。**
当前离这个标准还差“真实端到端 + 授权/安全 + 文档一致 + 发布工程”。
