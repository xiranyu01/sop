# SOP 需求管理网页

用于管理客户、物料、机器人型号、场景、任务 SOP 和客户需求的内部工具。
Proto v1alpha1 是内部权威领域契约；YAML/PDF 只从已确认 revision 所属的不可变
sealed export bundle 生成。YAML v1 暂不支持导入，但保留 canonical name、UID、
revision identity 和来源 ID，便于外部系统追踪。

## 架构边界

- Cloudflare Pages Functions 是唯一 API runtime。
- D1 按资源保存 catalog、当前可编辑资源、不可变 revision、reviewed dependency、
  export bundle 和 bootstrap metadata；不存在全站 snapshot 或整模块 JSON 写入。
- R2 只保存附件字节；D1 保存稳定附件身份、服务端生成的 object key 和可选 HTTPS
  public URL。
- 所有可变资源写入都带独立 etag；过期写入只冲突该资源。
- TaskSop/Requirement 确认会原子创建不可变 revision 和 sealed bundle。旧 bundle
  不受后来资源修改影响。
- 环境必须显式应用 schema 并由 operator bootstrap。runtime 不读取 `data/*.json`
  作为 seed 或故障回退。

核心文档：

- [Proto v1alpha1 领域契约](docs/proto-v1alpha1.md)
- [YAML Export v1](docs/yaml-export-v1.md)
- [部署、bootstrap 与恢复](docs/operations/deployment-and-recovery.md)
- [开发说明](DEVELOPMENT.md)

## 本地开发

```bash
pnpm install
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，设置至少 8 位且仅供本机使用的 APP_PASSWORD
pnpm dev:init
pnpm dev
```

本地、preview、production 必须使用隔离的 D1、R2、migration history、secret 和
bootstrap marker。密码放在忽略的 `.dev.vars`、CI secret store 或 Cloudflare secret
binding 中，不能提交到仓库。可从 `.dev.vars.example` 复制本地模板；
`R2_PUBLIC_BASE_URL` 应配置为当前环境公开可访问的 R2 自定义域名或 `r2.dev` HTTPS
origin，新上传附件会在该 origin 下记录稳定 object URL。

`pnpm dev:init` 只操作 `.wrangler/local` 中的本地 D1：先校验当前 release fixture
manifest，再执行本地 migration、幂等 bootstrap 和 readiness 审计。它不会连接远程
Cloudflare，也不会启动服务；同一 release 可以安全重跑，已就绪时会直接结束且不会覆盖
页面中修改过的数据。
日常重启无需重复初始化，`pnpm dev:status` 可单独检查状态，
`pnpm dev`/`pnpm pages:dev` 只启动已初始化的 Pages runtime，默认地址为
`http://localhost:8788`。如果缺少 `.dev.vars` 或本地仓库未就绪，启动命令会直接给出
修复提示，而不会打开可编辑的空页面。

新环境严格按以下顺序初始化：

1. 应用 `migrations/` 中的 versioned D1 schema。
2. 从待部署 checkout 显式运行 `server/bootstrap/cli.ts bootstrap`。
3. 运行同一 CLI 的 `status`，要求固定 release manifest 精确匹配且完整性审计通过。
4. 部署并执行 readiness、页面和重启持久化验证。

完整命令及 D1 Time Travel 恢复步骤见[运维手册](docs/operations/deployment-and-recovery.md)。

## 验证

```bash
pnpm verify
pnpm test:e2e
pnpm test:e2e:pages
```

`verify` 覆盖 Proto、生成代码漂移、类型、单元/集成测试、资源级架构守卫、secret
守卫和生产构建。浏览器测试通过 Wrangler Pages + 隔离 D1/R2 验证当前页面流程及
runtime 重启后的持久化。

## 附件与恢复限制

单附件最多 100 MiB、最多十个 10 MiB part；文件名和结构化 metadata 也有固定上限。
本版本不验证确认/导出时的 R2 存在性或 URL/hash/size 一致性，也不实现物理清理。
解除附件引用不会删除 R2 对象，因此可能产生 orphan object。D1 Time Travel 只恢复
结构化数据，不恢复被外部删除的 R2 字节。
