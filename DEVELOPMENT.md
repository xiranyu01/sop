# SOP 需求管理网页开发说明

## 项目定位

这是一个本地优先的 SOP 客户需求管理工具，用来管理客户信息、物料信息、机器型号、场景/子场景库、全局字段词表和客户需求版本。

第一版目标是简单可运行、方便 review、方便后续迁移到正式系统。当前不包含登录、权限、数据库、多人并发和飞书同步。

## 技术栈

- 前端：Vite + React + TypeScript
- 后端：Express + TypeScript
- 包管理：pnpm
- 数据存储：本地 JSON 文件
- YAML 生成：yaml

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

## 常用命令

```bash
pnpm typecheck
pnpm build
pnpm preview
```

每次提交前建议至少运行：

```bash
pnpm typecheck
pnpm build
```

## 目录结构

```text
.
├── data/                       # 本地主数据 JSON
├── exports/                    # YAML 导出目录，生成产物，不建议提交
├── server/                     # Express API 与 YAML 导出逻辑
│   ├── index.ts                # API 入口
│   ├── store.ts                # JSON 文件读写
│   ├── versioning.ts           # 版本号和 ID 工具
│   └── yamlExport.ts           # requirement_yaml_v0.1 导出映射
├── src/                        # React 前端
│   ├── App.tsx                 # 主要页面和业务交互
│   ├── App.css                 # 页面样式
│   ├── main.tsx                # 前端入口
│   └── types.ts                # 前后端共享类型
├── index.html
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
└── vite.config.ts
```

## 数据文件

当前主数据都放在 `data/` 下：

- `data/customers.json`：客户信息
- `data/materials.json`：物料信息，物料有自动生成的 `SKU1`、`SKU2` 等 SKU 编号
- `data/robot-models.json`：机器型号、topic 信息
- `data/scenes.json`：场景与子场景库；场景下包含多个子场景，子场景有唯一编号和多个版本
- `data/requirements.json`：客户需求；保存需求版本、客户、机器人、全局要求、已选子场景引用和目标采集时长
- `data/global-fields.json`：全局字段词表；用于机器人状态、随机性字段、交付语言、质检策略等可复用枚举
- `data/material-state-rules.json`：历史保留文件；当前物料状态规则主要在子场景里直接维护

`exports/requirements/<requirement_id>/<version>.yaml` 是点击导出时生成的 YAML 文件，不是源数据。

注意：公开推送 GitHub 前请检查 `data/` 中是否包含真实客户、电话、邮箱、项目名或内部链接。公开仓库建议先脱敏，或改成样例数据。

## 核心概念

### 客户需求

客户需求是面向客户沟通和交付的主对象，编号使用 `R1`、`R2` 递增。每个客户需求包含多个版本。

客户需求中只锁定子场景引用：

- 子场景编号
- 子场景版本号
- 场景名和子场景名快照
- 该需求下的目标采集时长

导出 YAML 时，会根据锁定的子场景编号和版本号，从场景库里读取对应子场景正文。

### 场景与子场景

场景是子场景的目录容器。子场景有唯一编号，同一个子场景编号下可以有多个版本。

子场景内容包含：

- 已选物料与数量
- 物料初始状态
- 物料目标状态
- 机器人初始态、目标态和随机性要求
- 物料随机性要求
- 采集步骤和说明
- 子场景特有的采集操作要求、采集禁止操作
- 标注步骤、标注操作要求、标注禁止操作
- 参考记录和附件信息

### 全局字段

全局字段是可复用词表。页面左侧按更大的类别收纳，例如对象状态、随机性、采集/标注操作、交付/质检、基础字段。

字段支持启用/停用，不支持物理删除。停用字段不再出现在新的选择中，历史需求和历史子场景中的文字快照不受影响。

## 版本规则

- 新建客户需求默认生成 `0.0.1` 草稿。
- 草稿版本可以直接编辑，也可以删除，但至少保留一个版本。
- 确认后的客户需求只读。
- 编辑已确认客户需求时，会自动复制并生成新的补丁版本草稿，例如 `0.0.1 -> 0.0.2`。
- 子场景版本规则与客户需求一致。
- 客户需求引用具体子场景编号和版本号，子场景发布新版不会自动影响历史客户需求。

## API 概览

主要 API 定义在 `server/index.ts`。

- `GET /api/data`：读取全部本地主数据
- `POST /api/customers`：新增或更新客户
- `POST /api/materials`：新增或更新物料
- `POST /api/robot-models`：新增或更新机器型号
- `POST /api/global-fields`：新增或更新全局字段
- `POST /api/scenes`：新增或更新场景
- `POST /api/requirements`：新建客户需求
- `PUT /api/requirements/:id`：编辑客户需求；如果基准版本已确认，则生成新草稿版本
- `DELETE /api/requirements/:id/versions/:version`：删除客户需求草稿版本
- `POST /api/requirements/:id/confirm`：确认客户需求版本
- `POST /api/scenes/:sceneId/subscenes/:subsceneCode/versions`：创建或编辑子场景版本
- `DELETE /api/scenes/:sceneId/subscenes/:subsceneCode/versions/:version`：删除子场景草稿版本
- `POST /api/scenes/:sceneId/subscenes/:subsceneCode/confirm`：确认子场景版本
- `POST /api/requirements/:id/export-yaml`：生成 YAML，并写入 `exports/`

## YAML 导出

当前导出 schema 是 `requirement_yaml_v0.1`，顶层结构为：

```yaml
schema_version: requirement_yaml_v0.1
requirement: {}
customer: {}
robot: {}
global_requirements: {}
scenarios: []
open_questions: []
traceability: {}
```

导出逻辑在 `server/yamlExport.ts`。

导出原则：

- 页面字段和 YAML 字段保持语义一致。
- 客户需求只保存子场景引用，导出时读取对应子场景版本正文。
- `traceability` 只保留本地应用稳定可提供的信息。
- 历史遗留字段不主动清理，但导出时不再输出已废弃的操作中物料状态结构。

前端客户需求详情页支持：

- 生成 YAML 预览
- 复制 YAML
- 点击顶部“导出 YAML”下载文件

## 开发约定

- 保持简单实现，优先用现有类型和页面结构解决问题。
- 涉及数据结构变更时，同时检查：
  - `src/types.ts`
  - 前端表单和空模板
  - `server/yamlExport.ts`
  - `data/*.json` 的兼容性
- 不要直接删除历史数据字段，除非已经确认迁移策略。
- 新增可枚举字段时，优先考虑是否属于 `data/global-fields.json`。
- 需求和子场景保存文字快照，避免全局字段改名影响历史版本。
- 修改版本逻辑后，要手动验证草稿、确认、编辑已确认版本、删除草稿版本这四类路径。

## 手动验收清单

基础资料：

- 新增客户、物料、机器型号后刷新仍存在。
- 物料 SKU 自动递增，且不重复。

全局字段：

- 字段可新增、编辑、启用和停用。
- 左侧二级分组可展开收起。
- 停用字段不再出现在新的下拉选择中。

场景与子场景：

- 可以创建场景和子场景。
- 子场景详情页可以切换版本。
- 草稿可编辑，确认版本只读。
- 编辑确认版本会生成新的草稿版本。
- 已选物料、物料状态、机器人状态、随机性、采集步骤、标注步骤都能保存。

客户需求：

- 可以新建需求，并自动生成 `R1`、`R2` 递增编号。
- 可以添加多个子场景，并按场景分组展示。
- 已选子场景可跳转查看详情。
- 总目标时长和子场景时长合计有差异提示。
- 确认版本后再编辑，会生成新的草稿版本。

YAML：

- 点击“生成预览”能显示 YAML。
- 点击“复制”能复制 YAML。
- 点击顶部“导出 YAML”能下载文件。
- 导出的 YAML 能被 YAML parser 解析。
- 导出内容包含客户需求中的额外 topic 要求、采集步骤随机性、标注步骤和标注操作要求。

## 推送 GitHub 前检查

当前项目还没有 `.git` 目录。首次推送前建议按下面顺序处理：

1. 确认 `data/` 中没有真实客户隐私、内部链接或不适合公开的信息。
2. 确认 `exports/`、`dist/`、`node_modules/` 不会提交。
3. 运行校验：

```bash
pnpm typecheck
pnpm build
```

4. 初始化并提交：

```bash
git init
git add .
git status --short
git commit -m "Initial SOP requirement manager"
```

5. 创建 GitHub 仓库并推送。使用 GitHub CLI 的方式：

```bash
gh repo create sop-requirement-manager --private --source=. --remote=origin --push
```

如果已经在 GitHub 上创建好仓库：

```bash
git remote add origin git@github.com:<your-org-or-user>/sop-requirement-manager.git
git branch -M main
git push -u origin main
```

公开仓库建议先用样例数据替换当前 `data/` 内容；私有仓库也建议避免提交真实电话、邮箱和客户未确认的信息。

## 后续可迭代方向

- 增加自动化测试，覆盖版本生成和 YAML 导出映射。
- 增加数据导入/导出能力，方便和飞书 Base 同步。
- 将 `data/` 迁移到 SQLite 或服务端数据库。
- 增加登录、权限和审计记录。
- 将 YAML schema 文档化，并加入示例导出文件。
