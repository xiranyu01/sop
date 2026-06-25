# SOP 需求管理网页

一个轻量的本地 Web 工具，用来管理客户、物料、机器型号、场景/子场景版本、全局字段，以及客户需求版本。主数据保存为 JSON，客户需求可导出为 `requirement_yaml_v0.1` YAML。

线上部署推荐使用 Cloudflare Pages + Pages Functions + D1。GitHub Pages 只能托管静态页面，不能运行本项目的 `/api/*` 写入接口。

## 启动

```bash
pnpm install
pnpm dev
```

打开 Vite 输出的地址，通常是 `http://127.0.0.1:5173`。

## 开发说明

详细开发说明、数据结构、版本规则、YAML 导出规则和 GitHub 推送检查见：

- [DEVELOPMENT.md](./DEVELOPMENT.md)

## 数据文件

- `data/customers.json`: 客户信息
- `data/materials.json`: 物料信息
- `data/robot-models.json`: 机器型号
- `data/scenes.json`: 场景与子场景库；子场景按唯一编号管理，一个编号可有多个版本
- `data/requirements.json`: 客户需求；保存需求版本和锁定的子场景版本
- `data/global-fields.json`: 全局字段词表
- `exports/requirements/<requirement_id>/<version>.yaml`: 导出的需求 YAML

线上 Cloudflare 版本会把这些 JSON 数据保存到 D1 的 `app_data` key/value 表里；`data/*.json` 只作为首次初始化种子数据。

## 版本规则

- 新建客户需求默认是 `0.0.1` 草稿。
- 确认后的客户需求只读，再保存会生成新的补丁版本草稿。
- 子场景按唯一编号管理；确认后的子场景再保存会生成新的补丁版本草稿。
- 客户需求锁定具体子场景编号和版本号；子场景发布新版不会自动影响历史客户需求。

## 校验

```bash
pnpm typecheck
pnpm build
```

## Cloudflare 部署

1. 在 Cloudflare 创建 D1 数据库，例如 `sop-prod`。
2. 执行 [schema.sql](./schema.sql) 中的建表 SQL。
3. 在 Cloudflare Pages 连接 GitHub 仓库，设置：
   - Build command: `pnpm build`
   - Build output directory: `dist`
   - Production branch: `main`
4. 在 Pages 项目里绑定 D1：
   - Variable name: `DB`
   - D1 database: `sop-prod`
5. 添加环境变量：
   - `APP_PASSWORD=<访问密码>`
   - `NODE_VERSION=22`
6. 部署后访问 `https://<project>.pages.dev`，输入访问密码使用。

本地模拟 Cloudflare Pages Functions：

```bash
pnpm pages:dev
```

本地模拟密码默认为 `dev-password`。
