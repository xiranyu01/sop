# SOP 需求管理网页

一个用于管理客户、物料、机器人型号、场景、任务 SOP 和客户需求版本的内部工具。系统现在以 `coscene.sop.v1alpha1` Proto 资源图为内部权威领域契约；浏览器读取严格校验的 ProtoJSON 投影，持久化运行在可冻结、可切换的 canonical namespace 上。

YAML 只作为对外导出格式，不是第二套内部模型。v1 仅导出已确认 revision 的不可变依赖闭包，不提供 YAML 导入；格式为 `coscene.sop.export` / `1.0.0`，并携带 canonical resource name、UID、来源 ID 和 revision identity，便于外部系统反查和追踪。

设计说明：

- [Proto v1alpha1 领域契约](docs/proto-v1alpha1.md)
- [YAML Export v1 契约](docs/yaml-export-v1.md)
- [存储迁移与生产切换手册](docs/storage-migration-v1alpha1.md)
- [字段覆盖账本](docs/proto-field-coverage.md)

线上主部署使用 Cloudflare Pages + Pages Functions + D1；附件使用 R2 或其 S3 兼容接口。GitHub Pages 无法运行本项目的写接口和共享存储。

## 主要能力

- 管理客户、物料、机器人型号、场景、全局字段和物料状态规则。
- 管理带不可变 revision 的任务 SOP 与客户需求；已确认版本只读，继续编辑会创建新草稿。
- Requirement 的生产项固定引用 TaskSopRevision 和 RobotModelRevision，不跟随“最新版本”漂移。
- 支持需求附件、任务 SOP 附件、物料图片的分片上传与受控下载，单文件最大 1 GiB。
- 支持任务 SOP / Requirement 的 YAML 和 PDF 导出；YAML 只允许从已确认 revision 导出。
- Cloudflare 环境使用应用访问密码保护，适合内部协作。

## 本地启动

```bash
pnpm install
pnpm dev
```

前端通常在 `http://127.0.0.1:5173`，API 在 `http://127.0.0.1:8787`。

首次启动会从 `data/*.json` 兼容数据构建并校验 canonical generation，随后把权威运行时 snapshot 保存到 `data/canonical/`。可通过 `SOP_DATA_DIR`、`SOP_CANONICAL_DIR`、`SOP_UPLOADS_DIR` 和 `SOP_EXPORTS_DIR` 覆盖路径。附件对象保存在 `uploads/`，不提交到 Git。

## 验证

```bash
pnpm verify
pnpm test:e2e
pnpm test:e2e:pages
```

`verify` 包含 Proto 格式/lint/build、生成代码漂移、TypeScript、单元、集成和生产构建检查。两个 E2E 分别覆盖本地 Express 和接近生产的 Pages Functions + 隔离本地 D1/R2。

## 数据与兼容边界

- `proto/coscene/sop/v1alpha1/`：内部领域契约。
- `proto/coscene/sop/export/v1alpha1/`：YAML 导出契约。
- `data/*.json` 与 D1 `app_data`：迁移种子及限时回滚兼容输入，不再是 canonical runtime 的权威模型。
- `data/canonical/`：本地 canonical generation、namespace 和运行元数据。
- D1 `canonical_migration_generations`：可复核的迁移 generation 与报告。
- D1 `canonical_namespaces`：运行时 snapshot、epoch、写冻结状态和乐观并发 generation。
- D1 `canonical_store_meta.runtime_namespace`：显式激活的运行 namespace。
- `uploads/` / R2：附件对象；canonical snapshot 保存身份、可达性和清理/回滚租约。

当前 REST 写接口仍是 UI 兼容边界：服务端将 canonical snapshot 投影为 DTO，应用现有表单变更后再严格转换回 Proto。该适配器会保留到生产切换完成、回滚窗口关闭并明确签字后再删除。

## Cloudflare 部署

1. 创建 D1 数据库和可选 R2 bucket，并配置 `DB`、`ATTACHMENTS`、`APP_PASSWORD` 等 binding/secrets。
2. 用 `pnpm exec wrangler d1 migrations apply sop-prod --remote` 安装 expand-only schema。
3. 构建命令使用 `pnpm build`，输出目录为 `dist`，Node 使用 22。
4. 严格按照[生产切换手册](docs/storage-migration-v1alpha1.md)准备 generation、核验、显式激活、只读烟测和 reopen。

生产环境不要设置 `CANONICAL_BOOTSTRAP_MODE=auto`。默认行为是只构建、校验并冻结候选 namespace，返回 `503` 和 `candidateNamespace`，由操作员完成受控切换。`auto` 只用于本地 `pnpm pages:dev` 和隔离 CI E2E。回滚附件租约默认从候选准备时起保留 7 天；若“准备 + 审批 + 观察 + 回滚窗口”更长，应在首次准备前设置正整数 `CANONICAL_ROLLBACK_LEASE_DAYS`。

本地模拟 Pages Functions：

```bash
pnpm pages:dev
```

本地密码为 `dev-password`。更多 API、迁移和开发约定见 [DEVELOPMENT.md](DEVELOPMENT.md)。
