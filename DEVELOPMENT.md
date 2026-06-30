# SOP 需求管理网页开发说明

## 项目定位

这是一个本地优先、可部署到 Cloudflare 的 SOP 客户需求管理工具，用来管理客户信息、物料信息、机器型号、场景/子场景库、全局字段词表和客户需求版本。

第一版目标是简单可运行、方便 review、方便后续迁移到正式系统。当前只有应用内共享访问密码，不做用户账号、角色权限、操作审计和多人并发冲突处理。

## 技术栈

- 前端：Vite + React + TypeScript
- 本地后端：Express + TypeScript
- 线上后端：Cloudflare Pages Functions
- 线上主数据：Cloudflare D1，使用 `app_data` key/value 表保存现有 JSON
- 附件存储：本地 `uploads/`；线上可选 Cloudflare R2 `ATTACHMENTS` binding
- YAML 生成：`yaml`
- 包管理：pnpm

## 本地启动

```bash
pnpm install
pnpm dev
```

默认地址：

- 前端：http://127.0.0.1:5173
- API：http://127.0.0.1:8787

如果只启动其中一侧：

```bash
pnpm server
pnpm client
```

本地附件和图片会保存到 `uploads/`。该目录是运行时数据，已加入 `.gitignore`，不要提交。

## 常用命令

```bash
pnpm typecheck
pnpm build
pnpm preview
pnpm pages:dev
```

每次提交前建议至少运行：

```bash
pnpm typecheck
pnpm build
```

## 目录结构

```text
.
├── data/                         # 本地主数据 JSON，也是 D1 首次初始化种子数据
├── exports/                      # 本地 YAML 导出目录，生成产物，不建议提交
├── functions/
│   └── api/[[path]].ts           # Cloudflare Pages Function API 入口
├── server/                       # 共享 API、存储和导出逻辑
│   ├── api.ts                    # API 路由和业务规则
│   ├── d1Store.ts                # D1 key/value 存储
│   ├── index.ts                  # 本地 Express API 入口
│   ├── r2AttachmentStore.ts      # Cloudflare R2 附件存储适配
│   ├── store.ts                  # 本地 JSON 与 uploads 存储
│   ├── versioning.ts             # 版本号和 ID 工具
│   └── yamlExport.ts             # requirement_yaml_v0.1 导出映射
├── src/
│   ├── App.tsx                   # 主要页面和业务交互
│   ├── App.css                   # 页面样式
│   ├── main.tsx                  # 前端入口
│   └── types.ts                  # 前后端共享类型
├── uploads/                      # 本地上传文件，运行时生成，不提交
├── index.html
├── package.json
├── pnpm-lock.yaml
├── schema.sql
├── tsconfig.json
└── vite.config.ts
```

## 数据文件

当前主数据都放在 `data/` 下：

- `data/customers.json`：客户信息
- `data/materials.json`：物料信息，物料有自动生成的 `SKU1`、`SKU2` 等 SKU 编号，可保存图片元数据
- `data/robot-models.json`：机器型号和 topic 信息
- `data/scenes.json`：场景与子场景库；场景下包含多个子场景，子场景有随机短编号和多个版本
- `data/requirements.json`：客户需求；保存需求版本、客户、机器人、全局要求、附件、已选子场景引用和目标采集时长
- `data/global-fields.json`：全局字段词表；用于机器人状态、随机性字段、交付语言、质检策略、采集/标注操作要求等可复用枚举
- `data/material-state-rules.json`：历史兼容文件；当前物料状态规则主要在子场景里直接维护

`exports/requirements/<requirement_id>/<version>.yaml` 是本地点击导出时生成的 YAML 文件，不是源数据。

公开推送 GitHub 前请检查 `data/` 中是否包含真实客户、电话、邮箱、项目名或内部链接。公开仓库建议先脱敏，或改成样例数据。

线上 Cloudflare 版本不写本地文件，`data/*.json` 只作为 D1 首次初始化种子数据。运行时数据存储在 D1 的 `app_data` 表：

```sql
CREATE TABLE IF NOT EXISTS app_data (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

当前使用这些 key：

- `customers`
- `materials`
- `robotModels`
- `scenes`
- `requirements`
- `globalFields`
- `materialStateRules`

## 附件与图片

需求附件、子场景附件和物料图片共用同一套分片上传接口：

- 单个文件最大 1G
- 默认分片大小 16MB
- 本地 Express 写入 `uploads/`
- Cloudflare Pages Functions 写入 R2 bucket

线上如果没有绑定 R2 `ATTACHMENTS`，页面会禁用上传入口并显示存储未配置提示；主数据读取、编辑、YAML/PDF 导出仍可使用。

物料图片只允许上传 `image/*`。子场景附件支持图片或视频。需求附件不限制具体文件类型。

## 核心概念

### 客户与客户需求

客户是需求的归属对象。客户列表中会显示该客户累计需求数量，进入客户后可以查看历史需求。

客户需求面向客户沟通和交付。需求 ID 使用 6 位随机短编号，页面不作为主要信息展示，但会写入 YAML 的 `requirement.id` 和 `traceability.requirement_id`，用于稳定追溯。每个客户需求包含多个版本。

客户需求中只锁定子场景引用：

- 子场景编号
- 子场景版本号
- 场景名和子场景名快照
- 该需求下的目标采集时长

导出 YAML 或 PDF 时，会根据锁定的子场景编号和版本号，从场景库里读取对应子场景正文。

### 场景与子场景

场景是子场景的目录容器。子场景使用 6 位随机短编号，同一个子场景编号下可以有多个版本。编号主要用于系统追溯和 YAML，不在页面中重点展示。

子场景内容包含：

- 基础信息、描述和附件
- 已选物料与数量
- 物料初始状态和物料目标状态
- 机器人初始态、目标态和随机性要求
- 物料随机性要求
- 采集步骤和采集步骤随机性
- 子场景特有的采集操作要求、采集禁止操作、不完美但可接受的采集操作
- 标注步骤、标注操作要求、标注禁止操作
- 参考记录信息

### 全局字段

全局字段是可复用词表。页面左侧按更大的类别收纳，例如对象状态、随机性、采集操作、标注操作、交付/质检和基础字段。

字段支持新增、编辑、启用和停用，不支持物理删除。停用字段不再出现在新的选择中，历史需求和历史子场景中的文字快照不受影响。

## 版本规则

- 新建客户需求默认生成 `0.0.1` 草稿。
- 草稿版本可以直接编辑，也可以删除，但至少保留一个版本。
- 确认后的客户需求只读。
- 编辑已确认客户需求时，会自动复制并生成新的补丁版本草稿，例如 `0.0.1 -> 0.0.2`。
- 客户需求确认前会校验所有已选子场景版本；如果存在草稿或找不到的子场景版本，会拒绝确认并提示原因。
- 子场景版本规则与客户需求一致。
- 子场景 `0.0.1` 草稿可以编辑名称和描述；非 `0.0.1` 草稿只允许编辑版本描述等正文内容，不改历史子场景名称。
- 客户需求引用具体子场景编号和版本号，子场景发布新版不会自动影响历史客户需求。

## API 概览

主要业务 API 定义在 `server/api.ts`。本地 Express 入口 `server/index.ts` 和 Cloudflare Pages Function `functions/api/[[path]].ts` 都复用这套业务逻辑。

基础数据：

- `GET /api/data`：读取全部主数据
- `POST /api/customers`：新增或更新客户
- `POST /api/materials`：新增或更新物料，自动补齐 SKU
- `POST /api/robot-models`：新增或更新机器型号
- `POST /api/global-fields`：新增或更新全局字段
- `POST /api/material-state-rules`：历史兼容接口
- `POST /api/scenes`：新增或更新场景

客户需求：

- `POST /api/requirements`：新建客户需求
- `PUT /api/requirements/:id`：编辑客户需求；如果基准版本已确认，则生成新草稿版本
- `DELETE /api/requirements/:id/versions/:version`：删除客户需求草稿版本
- `POST /api/requirements/:id/confirm`：确认客户需求版本；所选子场景必须全部已确认
- `POST /api/requirements/:id/export-yaml`：生成 YAML。本地写入 `exports/`，线上只返回 YAML 文本和虚拟路径

子场景：

- `POST /api/scenes/:sceneId/subscenes/:subsceneCode/versions`：创建或编辑子场景版本
- `DELETE /api/scenes/:sceneId/subscenes/:subsceneCode/versions/:version`：删除子场景草稿版本
- `POST /api/scenes/:sceneId/subscenes/:subsceneCode/confirm`：确认子场景版本

附件和图片：

- `GET /api/storage-status`：查看附件存储是否可用
- `GET /api/attachments/:storageKey`：下载附件或图片
- `POST /api/requirements/:id/versions/:version/attachments/init`：初始化需求附件上传
- `PUT /api/requirements/:id/versions/:version/attachments/:uploadId/parts/:partNumber`：上传需求附件分片
- `POST /api/requirements/:id/versions/:version/attachments/:attachmentId/complete`：完成需求附件上传
- `POST /api/requirements/:id/versions/:version/attachments/:attachmentId/abort`：取消需求附件上传
- `DELETE /api/requirements/:id/versions/:version/attachments/:attachmentId`：删除需求附件
- `POST /api/scenes/:sceneId/subscenes/:subsceneCode/versions/:version/attachments/init`：初始化子场景附件上传
- `PUT /api/scenes/:sceneId/subscenes/:subsceneCode/versions/:version/attachments/:uploadId/parts/:partNumber`：上传子场景附件分片
- `POST /api/scenes/:sceneId/subscenes/:subsceneCode/versions/:version/attachments/:attachmentId/complete`：完成子场景附件上传
- `POST /api/scenes/:sceneId/subscenes/:subsceneCode/versions/:version/attachments/:attachmentId/abort`：取消子场景附件上传
- `DELETE /api/scenes/:sceneId/subscenes/:subsceneCode/versions/:version/attachments/:attachmentId`：删除子场景附件
- `POST /api/materials/:materialId/images/init`：初始化物料图片上传
- `PUT /api/materials/:materialId/images/:uploadId/parts/:partNumber`：上传物料图片分片
- `POST /api/materials/:materialId/images/:attachmentId/complete`：完成物料图片上传
- `POST /api/materials/:materialId/images/:attachmentId/abort`：取消物料图片上传
- `DELETE /api/materials/:materialId/images/:attachmentId`：删除物料图片

Cloudflare 环境要求所有 API 请求携带：

```text
Authorization: Bearer <APP_PASSWORD>
```

## YAML 导出

当前导出 schema 是 `requirement_yaml_v0.1`，顶层结构为：

```yaml
schema_version: requirement_yaml_v0.1
requirement: {}
customer: {}
robot: {}
global_requirements: {}
scenarios: []
traceability: {}
```

导出逻辑在 `server/yamlExport.ts`。

导出原则：

- 页面字段和 YAML 字段保持语义一致。
- 客户需求只保存子场景引用，导出时读取对应子场景版本正文。
- 需求 ID 和子场景 ID 只用于系统追溯，不作为页面主要展示字段。
- `traceability` 只保留本地应用稳定可提供的信息。
- 历史遗留字段不主动清理，但导出时不输出已废弃的操作中物料状态结构。
- `step_order`、`open_questions`、动作标签、随机频率等已从当前主导出结构中移除。

前端客户需求详情页支持：

- 生成 YAML 预览
- 复制 YAML
- 点击顶部“导出 YAML”下载文件

## PDF 导出

PDF 导出在前端生成，不依赖服务端文件系统：

- 子场景详情页可导出当前子场景版本 PDF。
- 客户需求详情页可导出整个需求 PDF。
- 需求 PDF 会展开已选子场景引用并写入对应子场景版本正文。

## 开发约定

- 保持简单实现，优先用现有类型和页面结构解决问题。
- 涉及数据结构变更时，同时检查：
  - `src/types.ts`
  - 前端表单和空模板
  - `server/api.ts`
  - `server/yamlExport.ts`
  - `data/*.json` 的兼容性
- 不要直接删除历史数据字段，除非已经确认迁移策略。
- 新增可枚举字段时，优先考虑是否属于 `data/global-fields.json`。
- 需求和子场景保存文字快照，避免全局字段改名影响历史版本。
- 修改版本逻辑后，要手动验证草稿、确认、编辑已确认版本、删除草稿版本这四类路径。
- 修改上传逻辑后，要同时验证本地 `uploads/` 和线上 R2 binding 场景。

## 手动验收清单

基础资料：

- 新增客户、物料、机器型号后刷新仍存在。
- 物料 SKU 自动递增，且不重复。
- 物料可以上传、下载和删除图片。

全局字段：

- 字段可新增、编辑、启用和停用。
- 左侧二级分组可展开收起。
- 停用字段不再出现在新的下拉选择中。
- 采集操作要求、采集禁止操作、不完美但可接受的采集操作、标注操作要求和标注禁止操作可在需求或子场景中选择。

场景与子场景：

- 可以创建场景和子场景。
- 场景 ID 和子场景编号不会在页面中作为主要字段展示。
- 子场景详情页可以切换版本。
- 草稿可编辑，确认版本只读。
- 编辑确认版本会生成新的草稿版本。
- 草稿版本可以删除，且至少保留一个版本。
- 已选物料、物料状态、机器人状态、随机性、采集步骤、标注步骤都能保存。
- 物料状态表格的参照物、相对位置、支撑面是单选，长表格有可见横向滚动条。
- 子场景可以上传、下载和删除图片或视频附件。
- 子场景 PDF 可以正常导出。

客户需求：

- 可以新建需求，并自动生成 6 位随机短 ID。
- 需求 ID 不在页面中作为主要字段展示，但 YAML 中保留。
- 可以添加多个子场景，添加时可选择具体版本，默认选择最新版。
- 已选子场景按场景分组展示，并可跳转查看详情。
- 从需求页跳转到子场景详情时，子场景页顶部有返回需求页按钮。
- 总目标时长和子场景时长合计有差异提示。
- 如果已选子场景存在草稿或缺失版本，需求确认按钮应禁用或后端拒绝确认。
- 确认版本后再编辑，会生成新的草稿版本。
- 需求附件可以上传、下载和删除，单个附件不超过 1G。
- 需求 PDF 可以正常导出。

YAML：

- 点击“生成预览”能显示 YAML。
- 点击“复制”能复制 YAML。
- 点击顶部“导出 YAML”能下载文件。
- 导出的 YAML 能被 YAML parser 解析。
- 导出内容包含客户需求中的额外 topic 要求、采集步骤随机性、标注步骤、标注操作要求、采集禁止操作和不完美但可接受的采集操作。
- 导出内容不包含 `open_questions` 和已废弃的操作中物料状态结构。

## Cloudflare 部署

本项目不要用 GitHub Pages 做主部署。GitHub Pages 只能托管静态前端，不能运行 `/api/*`，也不能保存共享数据。

推荐部署方式：

1. 在 Cloudflare Workers & Pages 创建 D1 数据库，例如 `sop-prod`。
2. 在 D1 控制台执行 [schema.sql](./schema.sql)。
3. 可选但推荐：创建 R2 bucket，例如 `sop-attachments`。
4. 在 Cloudflare Pages 连接 GitHub 仓库 `xiranyu01/sop`。
5. Pages 构建配置：
   - Production branch: `main`
   - Build command: `pnpm build`
   - Build output directory: `dist`
6. Pages Functions 绑定：
   - D1 binding variable name: `DB`
   - D1 database: `sop-prod`
   - R2 binding variable name: `ATTACHMENTS`
   - R2 bucket: `sop-attachments`
7. Pages 环境变量：
   - `APP_PASSWORD=<访问密码>`
   - `NODE_VERSION=22`
8. 重新部署，访问 `https://<project>.pages.dev`。

首次访问 `/api/data` 时，如果 D1 中没有对应 key，会从 repo 内 `data/*.json` 初始化种子数据。

本地模拟 Pages Functions：

```bash
pnpm typecheck
pnpm build
pnpm pages:dev
```

`pnpm pages:dev` 会把本地访问密码绑定为 `dev-password`。线上密码必须在 Cloudflare Pages 环境变量中配置 `APP_PASSWORD`。

## GitHub 推送前检查

```bash
git status --short
pnpm typecheck
pnpm build
```

推送前确认：

- `uploads/`、`exports/`、`dist/`、`.wrangler/` 没有被提交。
- `data/` 中没有不该公开的客户隐私或内部敏感信息。
- `README.md` 和 `DEVELOPMENT.md` 与当前功能一致。
- 如果要让线上立即更新，Cloudflare Pages 已连接 `main` 分支，或手动触发重新部署。
