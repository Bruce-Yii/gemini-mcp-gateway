# 四个 MCP 里"基本用不上"的工具（调研报告）

> 日期 2026-11-20。基于当时的实际工具清单（442 个工具的 name+description）逐项分析；该清单现已增至 456 个（Vercel 259→273），新增工具未逐项标注。
> **本报告的标注已落到配置**：`config.example.json` 的 `denyTools` 现为 GitHub 4 / Notion 24 / Linear 24 / Vercel 213——**当前不是全量放行**，不要按"全量"理解现状。
> 场景锚点：个人用户，通过 Gemini 网页版对 GitHub / Notion / Linear / Vercel 做日常查看与管理。

## 总览

| 服务 | 总数 | 明确用不上 | 存疑 | 保留核心 |
|---|---|---|---|---|
| GitHub | 46 | 4 | 7 | 35 |
| Notion | 77 | 24 | 32 | 21 |
| Linear | 60 | 24 | 16 | 20 |
| Vercel | 259 | 212 | 33 | 14 |
| **合计** | **442** | **264** | **88** | **90** |

注意：写操作**没有**因为是写操作就被判"用不上"——建 issue/页面/PR、save_issue、create_pull_request 等全部在保留组。判"用不上"的标准是"个人日常场景无交集"或"企业/内部机制专属"。

---

## GitHub（46 → 用不上 4）

**明确用不上：**
- `get_teams`、`get_team_members` — 组织团队查询，个人无组织
- `list_repository_collaborators` — 仓库协作者，个人仓库只有自己
- `ui_get` — 给 MCP Apps 界面拉下拉数据的内部辅助工具

**存疑（倾向保留）**：`request_copilot_review`（需 Copilot 订阅）、`run_secret_scanning`、`sub_issue_write`、`list_issue_fields`、`list_issue_types`、`get_label`、`search_users`

**保留核心 35 个**：仓库/文件读写、commit/tag/release、issue 全套、PR 全套（含 create/merge）、search_code、get_me。

---

## Notion（77 → 用不上 24）

**明确用不上：**
- **Custom Agent / session 管理（10）**：`notion-search-agents`、`notion-search-sessions`、`notion-query-sessions`、`notion-spawn-session`、`notion-get-session-status`、`notion-wait-session`、`notion-stop-session`、`notion-send-message-to-session`、`notion-list-session-events`、`notion-read-session-event` — 全是驱动 Notion 自己 AI agent 的，需 Notion AI + Custom Agents
- **Agent Skills（5）**：`notion-convert-page-to-skill`、`notion-upload-skill`、`notion-download-skill`、`notion-get-enabled-skills`、`notion-update-skill-settings`
- **团队/权限（3）**：`notion-get-teams`、`notion-get-groups`、`notion-get-users`
- **设置/元工具（3）**：`notion-get-tool-access`、`notion-complete-mcp-setup`、`notion-get-setup-guide`
- `notion-query-multiple-data-sources`（需 Business/Enterprise + AI）
- `notion-calendar-list-coworkers-events`、`notion-calendar-list-calendar-resources`（团队/管理员专属）

**存疑 32 个**：suggested-edit 三件套（需 Business）、整个日历组（6 个，个人用日历 App）、会议记录组（3 个）、版本历史（3 个）、侧栏/收藏/反链、视图 create/update（**若用看板管任务则保留**）、memory-search 等。

**保留核心 21 个**：search/fetch/query-data-sources、create-pages/update-page、create-database、create-comment 全套、delete 三件套（显式要求时用）、list-favorite/recent-pages、file-download-urls、duplicate/move-pages。

---

## Linear（60 → 用不上 24）

**明确用不上：**
- **附件复杂上传链路（5）**：`prepare_attachment_upload`、`prepare_file_upload`、`create_attachment_from_upload`、`create_attachment`（deprecated）、`delete_attachment`
- **标签定义/生命周期（7）**：`save_issue_label`、`create_issue_label`、`retire_issue_label`、`restore_issue_label`、`save_project_label`、`retire_project_label`、`restore_project_label`
- **发布管理整套（7）**：`list_release_pipelines`、`list_releases`、`get_release`、`save_release`、`list_release_notes`、`get_release_note`、`save_release_note`
- **权限/团队（3）**：`share_issue`、`unshare_issue`、`get_triage_responsibility`
- **Linear Agent（2）**：`list_agent_skills`、`get_agent_skill`

**存疑 16 个**：`list_cycles`、`list_custom_views`、`search_documentation`、`get_attachment`（URL 5 分钟过期）、`list_templates`/`get_template`、milestones 三件套、`list_users`/`get_user`、status updates 等。

**保留核心 20 个**：list/get/save_issue、issue 状态/标签查询、文档 list/get/save、评论全套、项目 list/get/save、通知 get/mark、team/workspace 查询。

> 边界项：`save_project` 保留（个人也管自己的项目），若严格按"项目管理=团队管理"可拿掉。

---

## Vercel（259 → 用不上 212）

Vercel 的 259 个工具里绝大多数是细碎底层 API 和企业运维功能。按类别：

**明确用不上（212，分类列举）：**
- Flags 功能开关（20）、防火墙/安全（6）、KMS 密钥（9）、Sandbox 代码沙箱（29）、Vercel CI 内部（15）、Edge Config（13）、日志 Drains（5）、集成连接器（11）、团队/SSO（9）、账单合同（2）、路由规则管理（5）、批量重定向（5）、渐进式发布（7）、项目/部署高危写+环境（17）、域名购买/DNS 变更（21）、缓存/追踪/失效（6）、Toolbar/Board 协作（15）、AI Gateway 用量（2）、Agent Runs（4）、其他底层（14）
- 判定信号：desc 含 `Enterprise customers` / `private-beta access` / `requires_user_action` / `credential`/`secret`/`decrypted value` 的一律不放行给网页端连接器

**存疑 33 个**：只读查看为主——部署文件树、别名、DNS 记录查询、域名价格/可用性、SSL 证书、访问量统计（count_pageviews/count_events）、环境变量查询（涉及secret需权衡）、AI Gateway 模型清单、`cancel_deployment`（偶发写操作，看安全策略）。

**保留核心 14 个**：
`search_vercel_documentation`、`list_projects`/`get_project`、`list_deployments`/`get_deployment`、`list_deployment_events`、`get_runtime_logs`/`get_runtime_errors`、`get_project_trace`、`list_domains`/`get_domain`、`list_project_domains`、`list_teams`/`get_auth_user`。

---

## 关键结论

1. **真正"用不上"的大头在 Vercel**（212/259）——它是把整个 Vercel 平台 API 都搬成了 MCP，个人场景只碰其中 14 个。
2. **GitHub 几乎全能用**（只 4 个用不上）——它本来就是面向个人开发者的工具集。
3. **Notion/Linear 的"用不上"主要是内部机制**（agent session、skill、团队管理、发布管理），不是核心文档/issue 能力。
4. **写操作全部保留**——本轮没有任何工具因为"是写操作"被判用不上。
5. 本报告的"明确用不上"已按服务写入 `config.example.json` 的 `denyTools`（GitHub 4 / Notion 24 / Linear 24 / Vercel 213；本报告写 Vercel 212，快照后该服务工具数从 259 变为 273）；"存疑"项仍全部放行，未逐项收敛。

## 来源
- 工具清单：`data/tool-dataset.json`（分析时 442 个工具的 name+description，实测抓取；当前文件为 456 个）
- 四个服务的逐项分析由子代理基于清单完成
