# SOP 需求管理网页

一个轻量的本地 Web 工具，用来管理客户、物料、机器型号、场景/子场景版本、全局字段，以及客户需求版本。主数据保存为 JSON，客户需求可导出为 `requirement_yaml_v0.1` YAML。

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
