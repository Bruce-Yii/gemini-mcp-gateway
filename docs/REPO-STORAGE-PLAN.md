# 仓库文件存储架构：要不要按六模块重排

> 结论：**需要“逻辑上按六模块对齐”，不需要现在做“物理大搬家”。**
> 现在重排 486 个 tracked 文件，收益低于风险；先把模块映射、边界和依赖方向固定下来，等真实验收稳定后再分模块迁移。

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

问题：

- `src/` 是扁平 25 个文件，模块边界靠文件名和文档理解；
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

## 3. 为什么现在不建议物理大搬家

1. **import 路径大面积变化**：127 个测试、39 个脚本、api 入口、CI、部署都引用 `src/*`；
2. **OSS 导出 allowlist/neutralizer** 要同步改，否则公开包结构错；
3. **docs 194 个链接**会大面积断；
4. **并发 agent 作用域**会乱，容易冲突；
5. **当前真实客户端/写/授权未验收**，先动结构会掩盖功能问题；
6. 结构重排不会直接让 Gemini 更稳，优先级低于 P0。

---

## 4. 推荐做法：先逻辑、后物理

### 阶段 A（现在，低风险）

1. 新增 `docs/REPO-MAP.md`：每个 src/test/script 文件 → 六模块归属；
2. 新增 `scripts/check-module-boundaries.mjs`：只检查依赖方向，不移动文件；
3. 文档树加索引：`docs/architecture/README.md` 等，不迁移文件；
4. 新文件一律按模块命名/目录放置，旧文件先不动。

### 阶段 B（验收稳定后，分模块迁移）

一次只迁一个模块：

1. `src/client/` 迁移 + 兼容 re-export；
2. 更新 import、测试、脚本、OSS allowlist；
3. 跑全量 + 真实客户端；
4. 再迁 execution/upstream/evidence/runtime；
5. 最后迁 tests/docs。

每次迁移必须满足：

- 全量测试 0 fail；
- OSS `--check` PASS；
- 真实客户端任务不回归；
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

> **现在要的是“文件到模块的映射和依赖边界”，不是“马上把 486 个文件搬成六层目录”。**
> 结构应该服务验收，不是先搬家再找问题。
