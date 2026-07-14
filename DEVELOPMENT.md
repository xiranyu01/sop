# SOP 开发说明

## 权威模型与数据流

Proto v1alpha1 定义资源身份、引用、lifecycle、revision、冻结依赖和附件 metadata。
表单/view model 是 UI 边界，不是第二套领域模型。YAML/PDF 是不可变 export bundle
的版本化投影，不参与内部读写，当前也不支持 YAML 导入。

```text
Proto message -> validate/project -> one resource row in D1
confirmed revision -> FrozenExportContent -> sealed bundle -> YAML/PDF
attachment metadata -> D1       attachment bytes -> R2
```

D1 持久化五类独立数据：

- catalog resources：customer、material、scene、global field、material-state rule、
  attachment；
- current resources：RobotModel、TaskSop、Requirement；
- immutable revisions，包括显式标记的 imported draft checkpoint；
- normalized reviewed dependencies；
- immutable sealed export bundles 和 bootstrap metadata。

任何生产 row 都不能代表整站或整个模块。列表只返回按 canonical name 排序的 summary
page；detail 单独加载。完整 Proto 写入后由同一个 projector 推导 name、uid、kind、
lifecycle、etag、revision pointer 等查询列，读取/readiness 会重新投影并 fail closed。

## Runtime 与初始化

Cloudflare Pages Functions/Wrangler 是唯一 API runtime。本地、preview 和 production
各自使用隔离 D1、R2、secret、migration history 和 bootstrap marker。

```bash
pnpm install
pnpm pages:dev
```

新数据库必须由 operator 显式初始化：

```bash
pnpm exec tsx server/bootstrap/cli.ts manifest --fixture-dir data
pnpm exec tsx server/bootstrap/cli.ts bootstrap --fixture-dir data --dry-run
pnpm exec wrangler d1 migrations apply <database> --remote --env <environment>
pnpm exec tsx server/bootstrap/cli.ts bootstrap --fixture-dir data --database-id "$DATABASE_ID"
pnpm exec tsx server/bootstrap/cli.ts status --database-id "$DATABASE_ID"
```

`bootstrap` 是唯一允许读取 repository fixtures 的路径。它把旧 fixture deterministic
地拆成独立记录，通过 `EMPTY -> IN_PROGRESS -> COMPLETE` CAS marker 支持同 digest
中断恢复，并拒绝不同 digest 或同 key 不同内容。runtime startup、request 和页面初始
加载都不得 import fixture、自动 seed 或回退到空数据。runtime 只依赖
`server/bootstrap/releaseManifest.ts` 中随 release 冻结的 digest/counts。

schema/bootstrap/D1 失败必须返回 blocking readiness；UI 在 authoritative data 加载成功
前不可编辑。完整部署和 Time Travel 流程见
[docs/operations/deployment-and-recovery.md](docs/operations/deployment-and-recovery.md)。

## 资源写入约定

- `name` 是 canonical resource name，`uid` 是不可变 UUID，`display_name` 可编辑，
  `source_id` 只保存旧来源身份。
- 浏览器不能生成 canonical name、uid、revision identity、version sequence 或附件 key。
- 每个 mutable mutation 必须提交 expected etag；成功后只采用该响应的新 etag。
- repository update 只能涉及一个资源，或一个明确的 root lifecycle transaction。
- current TaskSop/Requirement 是唯一 runtime draft；确认才创建不可变 Revision。
- legacy 多 draft TaskSop 中，最新 draft 成为 current，其余保留为只读
  `IMPORTED_DRAFT_CHECKPOINT`，不能确认、选择或导出。
- RobotModel 每次保存追加不可变 revision；Requirement 固定引用 revision，而非“最新”。
- 直接依赖 review 必须确认 exact proposal digest，最多 500 条；autosave 不可偷偷推进
  reviewed baseline。
- confirmed revision/bundle 不可原地修改或删除；archive 默认是 soft archive。

所有含 ProtoJSON 的 prospective row 都要合计 variable-length column 的 UTF-8 字节：
1,500,000 bytes 起记录 warning，1,800,000 bytes 起在 D1 前拒绝。partial update、
confirmation 和 bootstrap 使用同一 guard。

## 导出

YAML/PDF endpoint 只按 confirmed root revision 读取已持久化 sealed bundle，不能重新读取
当前 catalog 拼装历史内容。YAML 对同一 bundle 必须 byte-identical；PDF 保证记录的
renderer/template version 下业务内容与 layout 稳定，不承诺 PDF 文件字节相同。未知
bundle schema/renderer version 必须拒绝，不能猜测 upcast。

## 附件

- 服务端为每次 upload 生成新的 uid/object key，不允许覆盖或由客户端替换 key。
- 最多十个 part，总计 100 MiB；非最后一个 part 必须恰好 10 MiB。
- UTF-8 filename 最多 255 bytes，结构化 metadata 合计最多 16 KiB。
- 非空 public URL 写入时必须是 absolute HTTPS URL。
- provider/upload failure 必须显式返回；confirm/export 不做 live R2、DNS、URL、hash 或
  size consistency check。
- unlink 只改 metadata，不物理删除 R2 object。本版本没有 cleanup/lifecycle worker。

## 验证

```bash
pnpm proto:check
pnpm proto:drift
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm build
pnpm verify
pnpm test:e2e
pnpm test:e2e:pages
```

改领域语义时先改 Proto/validation，再生成代码、更新 projector/service/tests。改 mutation
时同步更新 mutation-contract manifest；新增生产 source/SQL 不得引入 whole-site read/
write authority。不得提交 `.env*`、`.dev.vars*` 或明文 APP_PASSWORD/R2/Cloudflare
credential。

## 主要目录

```text
proto/                         Proto 领域与 export 契约
gen/                           Buf 生成代码（禁止手改）
migrations/                    fresh resource-scoped D1 schema
server/bootstrap/              operator-only conversion、CAS bootstrap、fixed readiness
server/domain/                 identity、validation、lifecycle service
server/repositories/           D1 repository 与 Proto projector
server/export/                 sealed bundle 与 YAML export
functions/api/                 Pages API 入口
src/api, src/persistence/      resource client、per-resource save queue/conflict state
src/export/pdf/                versioned PDF renderer
tests/                         unit、integration、Pages/Playwright E2E
docs/operations/               deployment/recovery runbook
```
