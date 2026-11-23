# FREEZE — 2026-11-24 physical module migration

> 第三个冻结点：src/ 物理迁移到六模块目录，旧路径保留兼容 shim。
> 不是发布，不是验收通过。

## 冻结点

- 分支：`main`
- commit：`e80a171`
- tag：`freeze-2026-11-24-modules`

## 迁移结果

```text
src/
  client/      oauth, client-platform, client-profile
  execution/   codemode, codemode-v2, codemode-util, typed-plan,
               tool-format, result-normalize, github-helpers, file-write
  upstream/    upstreams, upstream-auth, upstream-oauth, figma-guard
  evidence/    capture, capture-queue, project-tag
  runtime/     vercel-app, server
  shared/      config, sanitize, catalog, build-info, store
```

- 25 个主实现文件已迁入六模块目录；
- 25 个旧 `src/*.js` 路径保留纯 re-export shim；
- tests/scripts/api 旧 import 仍可用；
- `write-build-info.mjs` 递归扫描 src 子目录；
- `export-oss.mjs` 已包含模块目录；
- `check-module-boundaries.mjs` 按新路径扫描，排除 shim。

## 验证

```text
npm test                          1461 / 1455 pass / 0 fail / 6 todo
module boundaries                 new violations=0; legacy edges=9
local-e2e-verify                  ok
mcp-v2-smoke                      ok
export-oss --check                300 text files, CHECK PASSED
CI                                Node 20/22/24 success
```

## 仍未完成

- tests/scripts/docs 物理迁移；
- 9 条 legacy 依赖边解耦；
- 真实客户端/真实写/授权生命周期；
- 多客户端隔离/taskId；
- RuntimeAdapter/Docker；
- OSS L1。

## 规则

- shim 只是过渡，等 import 全切到新路径后删；
- 边界检查新增违规仍 fail；
- tag 不移动；
- 不把冻结点当发布。
