# SOP 需求管理网页开发说明

## 架构定位

项目以 Proto v1alpha1 为内部权威领域契约：资源、revision、引用、冻结依赖和附件身份都在 Proto 中定义。YAML 是 confirmed-only 的外部投影，不参与内部读写，也暂不支持导入。

当前 UI 仍使用适合表单编辑的 REST DTO。读链路是 canonical ProtoJSON → 严格 decode/validate → view model；写链路暂时是 canonical snapshot → REST DTO → 现有 route mutation → deterministic converter → Proto validate → atomic commit。后者是有意保留的迁移适配层，不应被误认为领域模型。

## 技术栈

- 前端：Vite + React + TypeScript
- 本地 API：Express + TypeScript
- 线上 API：Cloudflare Pages Functions
- 领域与序列化：Proto、Buf、Protobuf-ES、Protovalidate
- 本地 canonical 存储：文件 namespace，默认位于 `data/canonical/`
- 线上 canonical 存储：D1 `canonical_namespaces` + `canonical_store_meta`
- 兼容输入：`data/*.json`、D1 `app_data`
- 附件：本地 `uploads/`；线上 R2 binding 或 R2 S3 兼容接口
- YAML：`yaml`
- 测试：Vitest + Playwright
- 包管理：pnpm 11.5.1，Node 22

## 本地启动

```bash
pnpm install
pnpm dev
```

- 前端：http://127.0.0.1:5173
- API：http://127.0.0.1:8787

也可分别运行 `pnpm server` 和 `pnpm client`。常用路径可通过以下环境变量覆盖：

- `SOP_DATA_DIR`
- `SOP_CANONICAL_DIR`
- `SOP_UPLOADS_DIR`
- `SOP_EXPORTS_DIR`

## 必跑验证

```bash
pnpm verify
pnpm test:e2e
pnpm test:e2e:pages
```

单项命令：

```bash
pnpm proto:check
pnpm proto:drift
pnpm proto:breaking
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm build
```

`test:e2e` 驱动本地 Express/Vite；`test:e2e:pages` 构建生产产物，并使用 Wrangler Pages、隔离本地 D1 和 R2 执行同一组关键页面流程。

## 目录结构

```text
.
├── proto/coscene/sop/
│   ├── v1alpha1/                 # 内部权威领域契约
│   └── export/v1alpha1/          # YAML Export v1 契约
├── gen/                          # Buf 生成的 TypeScript；禁止手改
├── shared/
│   ├── domain/                   # 前后端共享 Proto decode/validate
│   └── transport/restDto.ts      # 临时 REST/form DTO 边界
├── server/
│   ├── domain/                   # canonical AppStore、服务、附件生命周期
│   ├── export/                   # confirmed-only YAML bundle exporter
│   ├── migrations/               # deterministic converter/generation/bootstrap
│   ├── api.ts                    # HTTP compatibility routes
│   ├── store.ts                  # 本地 canonical + legacy file/object adapter
│   └── d1Store.ts                # D1 canonical + legacy adapter
├── src/
│   ├── domain/                   # Proto → UI view model/form mappings
│   └── App.tsx                   # 页面与交互
├── functions/api/[[path]].ts     # Pages Function 入口
├── data/                         # 兼容种子；canonical 默认在 data/canonical/
├── migrations/                   # D1 expand-only SQL
├── tests/                        # unit / integration / Playwright E2E
└── docs/                         # 契约和生产 runbook
```

## Canonical 存储与迁移

### 本地

`server/index.ts` 启动时从兼容数据计算 source fingerprint，构建或复用 validated generation，然后把它作为 canonical namespace 运行。相同输入和版本重跑是 deterministic no-op；源数据或 converter/schema/identity 版本变化会得到新的 generation。

迁移诊断命令：

```bash
pnpm migration preflight --legacy-dir data
pnpm migration build --legacy-dir data --canonical-root .canonical --attachment-root uploads
pnpm migration resume --legacy-dir data --canonical-root .canonical --attachment-root uploads
pnpm migration validate --legacy-dir data --canonical-root .canonical --attachment-root uploads
pnpm migration report --canonical-root .canonical --generation <generation-id>
```

identity collision、缺失/歧义引用、坏日期、不可达托管附件或 semantic reconciliation 失败都会阻止 generation 进入 `VALIDATED`。

### Cloudflare D1

- `canonical_migration_generations` 保存来源 fingerprint、版本、manifest、snapshot 和报告。
- `canonical_namespaces` 保存运行 snapshot、epoch、写状态和 commit generation。
- `canonical_store_meta.runtime_namespace` 是显式激活 marker。
- `app_data` 仅保留为首次 bootstrap、现有适配器和限时回滚输入。

Pages 生产默认是 prepare-only：授权请求会构建、验证并冻结候选 namespace，但不写 marker，返回 503 和 `candidateNamespace`。只有本地/CI 使用 `CANONICAL_BOOTSTRAP_MODE=auto`。完整的迁移、核验、激活、只读烟测、reopen 和回滚步骤见 [docs/storage-migration-v1alpha1.md](docs/storage-migration-v1alpha1.md)。

## 核心领域规则

- `name` 是 canonical resource name；`uid` 是不可变 UUID；`display_name` 可修改；`source_id` 保存旧系统身份。
- revision 名是不可变资源名，`version_label` 是 `MAJOR.MINOR.PATCH` 人类版本。
- 已确认资源不可原地编辑；`StartDraft` 从确认 snapshot 开新草稿。
- Requirement production item 固定引用 `TaskSopRevision.name`，Requirement 同时固定 RobotModelRevision。
- `Confirm` 在一个原子提交中校验完整性、生成 revision、冻结依赖并更新 parent。
- 导出只能读取已确认 revision 和 frozen dependency context，禁止刷新当前 catalog。
- attachment 下载必须经过 canonical reachability；外部 URI 不得被解析为托管 storage key。

详细语义见 [docs/proto-v1alpha1.md](docs/proto-v1alpha1.md)。

## API 概览

本地 Express 和 Pages Function 共用 `server/api.ts`。

读取：

- `GET /api/canonical-data`：浏览器使用的完整 canonical ProtoJSON；客户端严格 decode/validate。
- `GET /api/data`：兼容 DTO 投影，仅供现有表单/API 路由。
- `GET /api/storage-status`：附件能力和可选公开基址。

资源 mutation：

- `POST /api/customers`
- `POST /api/materials`
- `POST /api/robot-models`
- `POST /api/global-fields`
- `POST /api/material-state-rules`
- `POST /api/scenes`
- `POST /api/requirements`
- `PUT /api/requirements/:id`
- `DELETE /api/requirements/:id/versions/:version`
- `POST /api/requirements/:id/confirm`
- `POST /api/scenes/:sceneId/subscenes/:subsceneCode/versions`
- `DELETE /api/scenes/:sceneId/subscenes/:subsceneCode/versions/:version`
- `POST /api/scenes/:sceneId/subscenes/:subsceneCode/confirm`

附件接口包含 init、part upload、complete、abort、delete 和受控 `GET /api/attachments/:storageKey`。路径仍使用旧资源 ID/version 是传输兼容策略，服务端最终提交 canonical attachment identity 和 lifecycle state。

Cloudflare API 要求：

```text
Authorization: Bearer <APP_PASSWORD>
```

未授权请求必须在读取 body、bootstrap D1 或访问 R2 前返回 401。

## YAML Export v1

规范入口是 `coscene.sop.export.v1alpha1.ExportBundle`：

```yaml
format: coscene.sop.export
schema_version: 1.0.0
root:
  kind: requirement
  ref: requirement-...
```

导出只接受已确认 TaskSopRevision 或 RequirementRevision，包含解释该 revision 所需的精确冻结闭包。每个 addressable entry 同时包含 bundle-local `ref` 和 `source.resource_name` / `source.uid` / 可选 `source.source_id`；revision 还包含 `revision_name`、`version_label` 和可选 `source_version_id`。

附件公开链接必须已作为绝对 HTTPS `public_uri` 冻结在 revision 中。导出器不读取 R2、DNS 或当前 deployment 配置，也不从内部 `storage_key` 拼链接。相同 snapshot 的输出必须 byte-identical。

完整规则见 [docs/yaml-export-v1.md](docs/yaml-export-v1.md)。YAML import 未实现；未来 importer 必须按 `schema_version` 拒绝未知 major，严格解析 identity/reference，不能复用内部 storage key。

## 开发约定

- 改领域语义时先改 Proto 和验证规则，再生成代码、更新 service 与测试；不要手改 `gen/`。
- 改兼容 DTO 时同步检查 `shared/transport/restDto.ts`、`server/api.ts`、converter、view model 和字段覆盖账本。
- 不在浏览器生成 canonical ID、UID、revision name 或 version identity。
- confirmed snapshot、frozen dependency、source identity 和 attachment reachability 不允许静默回退到名字匹配或“最新版本”。
- mutation 必须经 namespace epoch/generation 原子提交；冻结状态下写入必须失败。
- 删除附件对象前检查当前可达性、活跃上传、cleanup intent 和 rollback lease。
- 生产切换不得使用 auto bootstrap；reopen 后不得 marker 回滚。
- legacy adapter 的删除放在回滚窗口关闭后的独立变更中。

## 手动验收清单

- 客户、物料、机器人、场景、全局字段可创建/编辑，刷新后仍存在。
- 任务 SOP 和 Requirement 可创建草稿、确认、从已确认版本开新草稿、删除草稿；确认版本保持只读。
- Requirement 只能固定到已确认 TaskSop revision；新版 SOP 不影响历史 Requirement。
- 附件可上传、刷新、下载、删除；删除后旧地址不可访问；外部 URL 不走托管下载接口。
- confirmed Task SOP / Requirement 的 YAML 重复导出 byte-identical，且携带 canonical identity；草稿导出失败。
- 页面重载、重新登录和 Pages 部署环境行为与本地一致。
