# 仓库文件存储架构：要不要按六模块重排

> 状态更新（2026-11-24）：**阶段 A 已完成；阶段 B 的 src 六模块物理迁移已完成
> （兼容 shim 保留），tests/scripts/docs 的物理迁移仍未做（阶段 C 未开始）。**
> 结论不变：不做 486 个 tracked 文件的全量大搬家；tests/scripts/docs 继续平铺，
> src 已按模块落位且旧路径 100% 兼容。详见 [REPO-MAP.md](REPO-MAP.md)。

---

## 1. 当前仓库形态

```text
api/                 1
src/                 25
tests/               127（扁平）
scripts/             39
docs/                194（ledger 79 / eval 41 / OSS 29 / audit 18 / 其他）
explore/             22
data/                9
templates/           33
examples/            4
harness/             1
bench/               4
```

问题（阶段 A 时的形态；src 项已由阶段 B 解决）：

- ~~`src/` 是扁平 25 个文件，模块边界靠文件名和文档理解~~ → 已迁到六模块目录；
- `tests/` 127 个文件全平铺，模块归属不清；
- `docs/` 已经 194 个文件，根层混杂；
- `scripts/` 39 个，评测/部署/OSS/auth 混在一起；
- 六模块只存在于文档，文件树没有表达。

---

## 2. 目标存储结构（逻辑目标）

```text
api/                         # Vercel 入口，保持
src/
  client/                    # 客户端适配
    oauth.js
    client-platform.js
    client-profile.js
    sanitize.js
  execution/                 # 核心底座
    codemode.js
    codemode-v2.js
    typed-plan.js
    tool-format.js
    result-normalize.js
    github-helpers.js
    file-write.js
  upstream/                  # 上游接入
    upstreams.js
    upstream-auth.js
    upstream-oauth.js
  evidence/                  # capture/eval
    capture.js
    capture-queue.js
    project-tag.js
  runtime/                   # HTTP/部署
    vercel-app.js
    server.js
    store.js
  shared/                    # 横切纯工具
    config.js
    errors.js
tests/
  client/
  execution/
  upstream/
  evidence/
  runtime/
  shared/
scripts/
  eval/
  auth/
  runtime/
  oss/
docs/
  architecture/              # FRAMEWORK / FULL / ARCHITECTURE*
  eval/
  oss/
  ledger/
  audit/
```

注意：`oauth.js` 也可以放 runtime；`config.js`/`store.js` 是 shared；这是逻辑归属，不是绝对。

---

## 3. 为什么不做 486 文件的物理大搬家（src 已单独完成）

1. **import 路径大面积变化**：127 个测试、39 个脚本、api 入口、CI、部署都引用 `src/*`；
   → src 已用兼容 shim 化解，tests/scripts/docs 的物理迁移仍不做；
2. **OSS 导出 allowlist/neutralizer** 要同步改，否则公开包结构错；
3. **docs 194 个链接**会大面积断；
4. **并发 agent 作用域**会乱，容易冲突；
5. **当前真实客户端/写/授权未验收**，先动结构会掩盖功能问题；
6. 结构重排不会直接让 Gemini 更稳，优先级低于 P0。

---

## 4. 推荐做法：先逻辑、后物理

### 阶段 A（低风险，✅ 已完成）

1. ✅ 已新增 `docs/REPO-MAP.md`：每个 src/test/script 文件 → 六模块归属；
2. ✅ 已新增 `scripts/check-module-boundaries.mjs`：只检查依赖方向，不移动文件；已有 9 条 legacy 边，新增违规 fail；
3. 文档树加索引：`docs/architecture/README.md` 等，不迁移文件（未做）；
4. 新文件一律按模块命名/目录放置，旧文件先不动。

### 阶段 B（src 六模块物理迁移，✅ 已完成；tests/docs 迁移未做）

src/ 的 25 个实现文件已一次性按六个模块 `git mv` 到
`src/{client,execution,upstream,evidence,runtime,shared}/`，旧 `src/xxx.js`
保留为纯 re-export shim（9 个有 default 的文件额外 re-export default）。
边界脚本改为只扫描实现目录、排除 shim，9 条 legacy 边按新路径重登记。

完成状态：

1. ✅ src 六模块物理迁移 + 兼容 shim；
2. ✅ 实现文件内部相对 import 已改为跨模块相对路径；tests/scripts/api 的旧路径 import 由 shim 承接；
3. ✅ OSS allowlist 覆盖整个 `src/`（实现 + shim），加入模块目录进入计划的校验；
4. ✅ 全量测试 / 边界脚本 / local-e2e / mcp-v2-smoke / OSS `--check` 均通过（证据见任务报告）；
5. ⏳ 真实客户端在线复验未做（按部署纪律另行安排，不随结构迁移触发部署）；
6. ❌ tests/、scripts/、docs/ 的物理迁移未做 → 归入阶段 C，不影响本次目标。

每次迁移必须满足：

- 全量测试 0 fail；
- OSS `--check` PASS；
- 真实客户端任务不回归（结构迁移本身不触发部署，保持现有生产构建）；
- 无并发 agent 写同一文件。

### 阶段 C（可选）

- tests 按模块分目录；
- scripts 按 eval/auth/runtime/oss 分目录；
- docs 按 architecture/eval/oss/ledger/audit 分目录；
- 更新所有链接与 CI。

---

## 5. 优先级

| 动作 | 优先级 | 原因 |
|---|---|---|
| REPO-MAP + 边界检查 | P0 | 立即减少“文件在哪/属哪个模块”的混乱 |
| docs 索引 | P0 | 194 个文档需要入口，不用搬家 |
| src 物理迁移 | P2 | 验收稳定后再做 |
| tests/scripts 物理迁移 | P2 | 影响面大 |
| docs 物理迁移 | P2 | 链接/OSS 影响大 |

---

## 6. 一句话

> **文件到模块的映射和依赖边界先行；src 已按六模块物理落位并用 shim 保持兼容，
> 其余 486 文件的全量大搬家仍不做。**
> 结构应该服务验收，不是先搬家再找问题。
