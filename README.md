# SOP 需求管理网页

一个轻量的 SOP 客户需求管理工具，用来管理客户、物料、机器型号、场景/任务 SOP 版本、全局字段和客户需求版本。需求可以导出为 `requirement_yaml_v0.4` YAML，也可以导出 PDF 便于沟通和归档。

线上主部署建议使用 Cloudflare Pages + Pages Functions + D1。GitHub Pages 只能托管静态页面，不能运行本项目的 `/api/*` 写入接口，也不能提供共享数据存储。

## 主要能力

- 客户与客户需求放在同一工作流里：可查看每个客户的历史需求和需求数量。
- 物料、机器型号、场景、任务 SOP、全局字段均用列表页管理，支持搜索。
- 物料自动生成 SKU 编号，支持上传物料图片。
- 场景下管理多个任务 SOP；任务 SOP 有内部随机短编号和多版本，页面、客户需求、YAML 都不保存或展示任务编号。
- 任务 SOP 可配置物料、物料初始/目标状态、机器人状态、随机性、采集步骤、标注步骤、操作要求和附件。
- 客户需求可添加多个生产需求项；每个需求项可维护名称、描述、场景、目标采集时长、目标采集数量，并单独选择要使用的任务 SOP 版本。
- 确认客户需求前会校验每个生产需求项是否已选择已确认的任务 SOP 版本。
- 已确认版本只读；再次编辑会自动生成新的草稿补丁版本，草稿版本可以删除。
- 支持需求附件、任务 SOP 附件和物料图片上传，单个文件最大 1G。
- 支持 YAML 预览、复制、下载，以及客户需求和任务 SOP PDF 导出。
- Cloudflare 线上版本使用应用内访问密码保护，适合第一版内部试用。

## Schema 版本

- `app_data_v0.1`：本地 JSON / D1 主数据结构版本。
- `requirement_yaml_v0.4`：客户需求 YAML 导出结构版本。
- `task_sop_yaml_v0.2`：任务 SOP YAML 结构版本，附件、示例图和物料图片会输出可访问 URL。

这些版本会写入 `data/metadata.json`，也会出现在需求 YAML 的 `schema_versions` 中，后续增删字段时可以按版本做兼容。

## 本地启动

```bash
pnpm install
pnpm dev
```

打开 Vite 输出的地址，通常是 `http://127.0.0.1:5173`。

本地开发使用 Express API 和 `data/*.json` 文件存储；附件和图片会保存到 `uploads/`，该目录已加入 `.gitignore`。

## 常用校验

```bash
pnpm typecheck
pnpm build
```

提交或部署前建议至少跑完这两条命令。

## 数据与存储

- `data/customers.json`：客户信息
- `data/materials.json`：物料信息，包含自动生成的 SKU 和可选图片元数据
- `data/metadata.json`：当前数据与 YAML schema 版本
- `data/robot-models.json`：机器型号和 topic 信息
- `data/scenes.json`：场景与任务 SOP 库；任务 SOP 内部按随机短编号管理，一个编号可有多个版本
- `data/requirements.json`：客户需求；保存需求版本、生产需求项和锁定的任务 SOP 版本，不保存任务编号
- `data/global-fields.json`：全局字段词表
- `data/material-state-rules.json`：历史兼容数据，当前物料状态规则主要在任务 SOP 内维护
- `exports/requirements/<requirement_id>/<version>.yaml`：本地导出的需求 YAML
- `uploads/`：本地上传的附件和图片，不提交到 GitHub

线上 Cloudflare 版本会把 JSON 主数据保存到 D1 的 `app_data` key/value 表里；`data/*.json` 只作为首次初始化种子数据。附件、任务 SOP 图片/视频和物料图片建议保存到 R2 bucket：同账号 R2 可通过 `ATTACHMENTS` binding 提供给 Pages Functions，跨账号 R2 可通过 S3 兼容访问参数提供。

## Cloudflare 部署

1. 在 Cloudflare 创建 D1 数据库，例如 `sop-prod`。
2. 执行 [schema.sql](./schema.sql) 中的建表 SQL。
3. 可选但推荐：创建 R2 bucket，例如 `sop-attachments`，用于附件和图片上传。
4. 在 Cloudflare Pages 连接 GitHub 仓库 `xiranyu01/sop`，设置：
   - Production branch: `main`
   - Build command: `pnpm build`
   - Build output directory: `dist`
5. 在 Pages 项目里绑定 D1：
   - Variable name: `DB`
   - D1 database: `sop-prod`
6. 如果启用附件上传，优先在 Pages 项目里绑定同账号 R2：
   - Variable name: `ATTACHMENTS`
   - R2 bucket: `sop-attachments`
7. 如果附件 bucket 在另一个 Cloudflare 账号，改用 Pages secrets 配置 S3 访问参数：
   - `R2_S3_ENDPOINT`
   - `R2_S3_BUCKET`
   - `R2_S3_ACCESS_KEY_ID`
   - `R2_S3_SECRET_ACCESS_KEY`
8. 添加环境变量：
   - `APP_PASSWORD=<访问密码>`
   - `NODE_VERSION=22`
9. 部署后访问 `https://<project>.pages.dev`，输入访问密码使用。

本地模拟 Cloudflare Pages Functions：

```bash
pnpm pages:dev
```

`pnpm pages:dev` 会使用 `dev-password` 作为本地访问密码。

## 开发说明

详细的数据结构、API、版本规则、YAML/PDF 导出规则、Cloudflare 部署说明和发布检查见 [DEVELOPMENT.md](./DEVELOPMENT.md)。
