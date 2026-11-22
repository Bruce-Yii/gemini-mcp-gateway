# Batch 11 · P0：Code Mode 里模型静默截断数据（2026-11-23）

> 范围：只写 `src/codemode.js`、`src/result-normalize.js`、`src/file-write.js`、
> 新增 `tests/no-silent-truncation.test.js`，并在
> `tests/result-normalize.test.js` / `tests/file-write.test.js` /
> `tests/codemode.test.js` 做必要追加；新增本台账。
> **未改** `src/capture.js`、`src/server.js`、`src/vercel-app.js`、`scripts/`、
> `.github/`、`README`、`CHANGELOG`。**未 commit / push / deploy**，改动全部留在工作区。

## 一、证据与定位

| 项 | 事实 |
|---|---|
| capture requestId | `363fd3e7-a9ff-44b7-b2f0-c1e4c27329b6`、`21896fe1-da1c-4682-93b9-1c8c53f5405c` |
| 模型代码 | 显式 `l.slice(0, 150)`，对结果里的每一行做字符截断 |
| 网关响应 | 完整（711 / 779 bytes，`overflow:false`） |
| `truncated` | 无标记；模型输出被截断但下游无法感知 |

结论：根因不是网关丢字节，而是**模型缺少"按行读 + 显式标记"的原语**，于是在沙箱里
自己手写 `slice(0,150)`，把完整数据静默削短。按本项目规则把免费模型建议视为待验证
假设，本批只依据上述原始 capture 事实 + 源码 + 确定性测试落地。

## 二、修复内容

### 1. 新增类型化读原语 `codemode.readFileRange`

签名：
```
codemode.readFileRange({
  path, startLine, endLine,
  maxCharsPerLine?,          // 可选；不传 = 绝不按字符截断
  tools?, readArgs?, owner?, repo?, branch?
})
```
返回：
```
{
  lines: string[],           // 完整原始行；仅在 opt-in 字符上限时逐行截短
  truncated: boolean,
  truncation?: {reason, ...},// 仅在 truncated 时出现
  nextStart: number|null,    // 还有后续行时给出下一页起始行
  totalLines: number
}
ok:false 时返回 {ok:false, error}
```

关键契约：
- **不传 `maxCharsPerLine` 绝不按字符截断**；长行逐字符原样返回（测试用 >150 chars 行，长度与内容全等）。
- 传了 `maxCharsPerLine` 必须是正有限整数；`0` / 负数 / 非数字直接 `{ok:false}`，不允许
  "悄悄截成空串"。每个超长行被切时都写明 `truncation.reason:'maxCharsPerLine'`、
  `maxCharsPerLine`、被切的 1-based `lines[]` 和 `detail`。
- **复用既有读取与归一化**：文件通过同一 `__dshCallTool` 工具桥读取（与
  `applyFilePatch` 同一路径），内容用 `codemode.normalizeFile`（host canonical adapter）
  提取，`fileResult` 只做 fallback。没有第二份上游读取/形状解析实现。
- 行区间裁剪、上游 `truncated` 标记、in-band `--- TRUNCATED ---` 都进入同一个
  `truncated` / `truncation`；多个原因合并为 `{reason:'multiple', causes:[...]}`。

### 2. 同类项清单（全部审计并修复/确认）

| 路径 | 问题 | 处理 |
|---|---|---|
| `codemode.js` `grepSnippet` | 按字符窗口 `s.slice(start,start+w)` 默认截长行，返回 `{index,text}` 无标记 | 每个片段新增 `fullLength`、`truncated`、`truncation:{reason:'grepWindow',window,start,end,detail}` |
| `codemode.js` `__dshB10ApplyFilePatch` | 读到截断内容后仍 applyPatch + 写回，会**覆盖掉未读的尾部**（毁灭性） | 读后若 `nf.truncated` 或含 `--- TRUNCATED ---`，直接 `{ok:false,error:'refusing to patch a truncated read...'}`，零写调用 |
| `file-write.js` `applyFilePatch` | host 端只拿到纯文本，无法看到上游 flag；但 in-band marker 若存在仍会被 patch+写回 | 写前检测 `--- TRUNCATED ---` 硬停，原子失败、不调 `write` |
| `file-write.js` `buildDiffSummary` | 预览硬限制 3 条 removed + 3 条 added，未标记其余被省略的变更行（安全上限静默） | 追加 `… N more changed lines omitted from preview` |
| `result-normalize.js` `normalizeFileResult` | 只认顶层布尔 / in-band marker；`result.truncated`、字符串 `'true'`、`truncation:{reason}` 会被当成完整 | 新增单一决策函数 `explainTruncation(root,content)`；保留 7 字段稳定集合，`truncated` 由它统一驱动，导出供调用方取原因 |
| `codemode.js` `sliceLines` | 已按行裁剪并带 `truncated`，无字符截断 | 确认无需改；新增测试覆盖 >150 chars 长行逐字符一致 |
| `codemode.js` `formatSearchDescription` | `s.slice(0,160)` + `…` 用于工具描述摘要 | 已有 `…` 显式标记，非文件数据，保留 |
| `src/tool-format.js` / `src/server.js` / `src/upstreams.js` / `src/capture.js` | `truncateResultValue` / `truncateResponseText` / 32MB byte cap 都有显式 `--- TRUNCATED ---` 或 `truncated:true` | 确认非静默，**不在本批写入范围**（未改） |

### 3. RETURN_SHAPE_GUIDANCE 更新

`execute` / `execute_read` 共用同一 guidance 后缀，新增明文：
- `NO SILENT CHARACTER TRUNCATION`：禁止 `l.slice(0, 150)` / `line.substring(0,N)`
  等任何手写逐行字符切割，指出这就是本次 P0 根因。
- 控制 context 请用 `readFileRange(...)` 或 `sliceLines(...)`，并**在回答里报告
  `truncated`**，按 `nextStart` 翻页。
- `grepSnippet` 的裁剪片段也会带 `truncated`。
- `truncated` 为真的读取不得 patch / write，必须先重读完整文件。

## 三、回归测试

新增 `tests/no-silent-truncation.test.js` **22 个测试**，并在三个既有测试文件追加
**6 个测试**（result-normalize 2、file-write 2、codemode 2）。全部 fake 工具、
纯本地、无网络/真实凭据。

覆盖矩阵：

| 要求 | 测试 |
|---|---|
| 长行（>150 chars）默认不截断、逐字符一致 | `readFileRange ... >150-char line`、`sliceLines ... long lines`、`shape *: readFileRange ...`（4 类） |
| 显式 `maxCharsPerLine` → `truncated:true`、原因明确 | `readFileRange: maxCharsPerLine truncates explicitly...`；非法值测试 |
| JSON 文本 / resources / content 数组 / 文件结果四类形状 | `SHAPES` 参数化 ×2（host adapter + sandbox 端到端）= 8 个测试；host 端另有 `batch11: long line survives every file shape...` |
| 现有 `applyFilePatch` 不因预检截断误写 | host + sandbox 两个测试（均断言零 write 调用）；另有 `applyTextPatch` 清洁补丁不回归 |
| 同类项 | `grepSnippet` 标记、`explainTruncation` 嵌套/字符串/对象 flag、diff summary 省略标记 |

### 测试结果

- `node --test tests/no-silent-truncation.test.js`：**22 / 22 通过**
- 范围测试（新增 + result-normalize + file-write + codemode + slice-lines +
  b10-write-semantics + b2-patch + normalization*）：**125 / 125 通过**
- 全量 `npm test`：**607 tests / 607 pass / 0 fail**（其他并行子代理的在途
  `scripts/capture-digest.mjs` 失败已在集成时修复；本批未改那些文件）
- `node --check src/codemode.js`、`src/result-normalize.js`、`src/file-write.js` 通过

## 四、仍未覆盖的风险

1. **模型端绕过**：模型仍可在 sandbox 里手写 `slice()` / `substring()` 或
   `JSON.stringify(...).slice(...)` 静默切数据。guidance 是提示而非沙箱静态拦截；
   本批没有做 AST 级禁止（那会破坏合法的字符串处理）。需要在模型侧/提示层持续观察。
2. **`unwrapResult` 丢失兄弟元数据**：`src/tool-format.js` 的 `unwrapResult` 在单文本块
   场景返回纯字符串，`truncated` / `truncation` 等兄弟字段不会进入 guest。
   `readFileRange` 因此主要依赖 in-band marker 与 `structuredContent` 路径来识别上游截断。
   该文件不在本批写入范围，未改；若上游改用兄弟 flag 而不写 marker，guest 侧可能看不出。
3. **`contentArrayToString` 多正文候选仍取最长一个**（既有行为，既有测试固定了它）。
   若上游同时返回两段不同的真实正文，会丢掉较短那段。本批未改，避免破坏既有契约。
4. **`resourcesToText` 按完整文本去重**（既有行为）：两段完全相同的长资源只保留一次。
   属上下文压缩，不是字符截断，本批保留。
5. **`maxResultChars`（默认 20000）仍会截断 execute 的返回值**，但用的是
   `tool-format.js` 的 structured truncator，带 `--- TRUNCATED ---` 标记，非静默。
6. **readFileRange 依赖工具名默认值** `github__get_file_contents`；非 GitHub 服务需显式传
   `tools.readTool` / `readArgs`。未提供会走 `ok:false`，不会伪造内容。
7. **未做真实 capture 回放 / L1 smoke**：按项目规则，只用本地 fake 上游做确定性验证；
   真实请求 ID 的证据来自用户提供，本批未联网读取凭据或远端 capture。
