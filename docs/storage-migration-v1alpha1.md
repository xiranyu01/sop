# Proto v1alpha1 存储迁移与生产切换手册

## 当前边界

Proto v1alpha1 是内部权威领域契约，canonical namespace 是运行时权威存储。`data/*.json`、D1 `app_data`、REST DTO 和 legacy converter 暂时保留，用于首次构建候选 generation、现有 UI 写接口适配和回滚。YAML v1 只有导出，没有导入。

本仓库提供安全的 prepare-only 默认行为，但不会替操作员修改远程生产 marker。生产切换需要部署权限、维护窗口、D1 Time Travel 记录和明确的回滚负责人。

关键约束：

- 生产环境不得设置 `CANONICAL_BOOTSTRAP_MODE=auto`；该值仅用于本地和隔离 CI。
- 候选 generation 必须是 `VALIDATED`，report 必须通过，namespace 必须写冻结。
- `runtime_namespace` 写入前可以回到旧部署；namespace reopen 后禁止删除 marker 回切，之后只允许 forward recovery。
- 回滚附件租约默认保留 7 天；窗口关闭前不得清理旧路径仍可能访问的对象。

## 0. 发布前证据

在候选 commit 上运行并保存输出：

```bash
pnpm verify
pnpm test:e2e
pnpm test:e2e:pages
pnpm proto:breaking
```

记录候选 Git SHA、Cloudflare deployment ID、当前生产 deployment ID、操作人、开始时间和回滚负责人。`proto:breaking` 在目标分支还没有 Proto baseline 时会明确跳过；baseline 建立后必须通过 Buf breaking 检查。

## 1. 保存回滚锚点并扩表

先记录已知可用部署，再记录 D1 Time Travel 信息：

```bash
pnpm exec wrangler d1 time-travel info sop-prod --timestamp <RFC3339> --json
pnpm exec wrangler d1 migrations apply sop-prod --remote
```

迁移是 expand-only：新增 `canonical_store_meta` 和 `canonical_namespaces`，不删除或改写 `app_data`、既有 generation 或附件对象。

## 2. 部署 prepare-only 候选

部署候选应用，保留 `DB`、附件 binding/secrets 和 `APP_PASSWORD`。不要配置 `CANONICAL_BOOTSTRAP_MODE`，也不要将其设为 `auto`。根据“准备 + 审批 + 观察 + 回滚窗口”的最长耗时，在首次准备前按需设置正整数 `CANONICAL_ROLLBACK_LEASE_DAYS`；未设置时默认 7 天。

用授权请求访问任一业务 API，例如：

```bash
curl -i -H 'Authorization: Bearer <APP_PASSWORD>' https://<deployment>/api/canonical-data
```

首次请求应返回 `503`，响应体包含 `candidateNamespace`。这代表服务已完成以下动作：

1. 从兼容输入计算 source fingerprint；
2. 构建并严格校验 deterministic generation；
3. 创建 canonical namespace 并写入回滚附件租约；
4. 冻结 namespace；
5. 不发布 `runtime_namespace`。

立即再请求一次并记录第二个 `candidateNamespace`。两个值必须完全相同；不同表示源数据在准备期间发生变化，必须停止切换、调查写入并重新开始本节。

## 3. 核验候选

将 `<candidate>` 替换为响应里的值：

```bash
pnpm exec wrangler d1 execute sop-prod --remote --command "SELECT generation_id, lifecycle, source_fingerprint, converter_version, storage_schema_version, canonical_schema_version, identity_version, validated_at FROM canonical_migration_generations WHERE generation_id = '<candidate>'"
pnpm exec wrangler d1 execute sop-prod --remote --command "SELECT namespace, epoch, writable, generation, updated_at FROM canonical_namespaces WHERE namespace = '<candidate>'"
pnpm exec wrangler d1 execute sop-prod --remote --command "SELECT key, value FROM canonical_store_meta WHERE key IN ('runtime_namespace', 'active_namespace', 'rollback_attachment_lease:<candidate>') ORDER BY key"
```

继续操作前必须同时满足：

- generation 恰好一行且 `lifecycle = 'VALIDATED'`；
- namespace 恰好一行且 `writable = 0`；
- 尚无 `runtime_namespace`；若已有，必须先确认它是否来自先前已完成的切换；
- generation 的 schema/converter/identity 版本和候选构建一致；
- rollback attachment lease 存在，且其 `expiresAt` 覆盖“候选准备开始到预计 reopen 后回滚窗口结束”的完整时段。默认租约从准备时开始计时；若部署审批或观察期可能超过 7 天，必须在准备前提高租约时长并重新生成候选，不能依赖 reopen 自动续期。

还应读取 `report_json` 并确认 `ok = true`，不存在 identity collision、缺失/歧义引用、坏时间或不可达托管附件。

## 4. 显式激活 marker（仍保持只读）

使用单条 conditional insert 激活；它只在 marker 不存在时生效：

```bash
pnpm exec wrangler d1 execute sop-prod --remote --command "INSERT INTO canonical_store_meta (key, value) SELECT 'runtime_namespace', '<candidate>' WHERE NOT EXISTS (SELECT 1 FROM canonical_store_meta WHERE key = 'runtime_namespace')"
pnpm exec wrangler d1 execute sop-prod --remote --command "SELECT key, value FROM canonical_store_meta WHERE key = 'runtime_namespace'"
```

必须确认 marker 值就是 `<candidate>`。若 insert 报告 0 changes 或值不同，停止操作，不要覆盖已有 marker。

## 5. 只读烟测

namespace 仍为冻结状态。验证：

- 正确密码可读取 `/api/canonical-data` 和 `/api/data`；错误密码返回 401；
- 客户、物料、机器人、场景、任务 SOP、Requirement 和历史 revision 数量正确；
- 已确认 Task SOP / Requirement 的 YAML 可以导出，内容含 `format: coscene.sop.export`、`schema_version: 1.0.0`、resource name、UID 和 revision name；
- 引用的托管附件可下载，已移除或外部 URI 不会被当作托管对象下载；
- 任一写请求因 namespace 冻结失败，并且 snapshot generation 不变化。

此时如果烟测失败，执行“reopen 前回滚”。

## 6. Reopen 写入

先从上一步查询记录期望的 `<epoch>`。第一条语句持久化不可逆的 reopen 证据；第二条语句只有在该证据存在且 namespace 仍处于预期冻结 epoch 时才执行 compare-and-swap：

```bash
pnpm exec wrangler d1 execute sop-prod --remote --command "INSERT OR IGNORE INTO canonical_store_meta (key, value) SELECT 'writes_reopened:<candidate>', datetime('now') FROM canonical_namespaces WHERE namespace = '<candidate>' AND epoch = <epoch> AND writable = 0"
pnpm exec wrangler d1 execute sop-prod --remote --command "UPDATE canonical_namespaces SET epoch = epoch + 1, writable = 1, updated_at = datetime('now') WHERE namespace = '<candidate>' AND epoch = <epoch> AND writable = 0 AND EXISTS (SELECT 1 FROM canonical_store_meta WHERE key = 'writes_reopened:<candidate>')"
pnpm exec wrangler d1 execute sop-prod --remote --command "SELECT namespace, epoch, writable, generation, updated_at FROM canonical_namespaces WHERE namespace = '<candidate>'"
pnpm exec wrangler d1 execute sop-prod --remote --command "SELECT key, value FROM canonical_store_meta WHERE key = 'writes_reopened:<candidate>'"
```

reopen marker 必须存在；更新必须恰好影响一行，并且新状态为 `epoch = <epoch> + 1`、`writable = 1`。若 marker 已写入但 UPDATE 未生效，系统保持只读并禁止 marker 回滚，必须调查 epoch 竞争后向前恢复，不得删除 reopen marker 或无条件重试。

从这一刻开始禁止通过删除或改写 `runtime_namespace` 回切旧模型，因为 canonical 写入可能已经发生。故障处理必须冻结当前 namespace、修复并向前迁移。

## 7. 写入烟测与观察

在批准的测试资源上执行：创建草稿、编辑、确认、从已确认版本开始新草稿、删除草稿、上传/下载/删除附件、导出 YAML/PDF。刷新页面并重新登录，确认数据仍一致。

观察 API 5xx、`WriteFrozenError`、`AtomicCommitError`、附件清理失败、D1 写冲突和 R2 错误。保留 7 天默认回滚附件租约；任何缩短都需要数据负责人签字。

## Reopen 前回滚

只有 namespace 仍为 `writable = 0` 时允许：

1. 用条件语句删除 marker：

   ```bash
   pnpm exec wrangler d1 execute sop-prod --remote --command "DELETE FROM canonical_store_meta WHERE key = 'runtime_namespace' AND value = '<candidate>' AND NOT EXISTS (SELECT 1 FROM canonical_store_meta WHERE key = 'writes_reopened:<candidate>') AND EXISTS (SELECT 1 FROM canonical_namespaces WHERE namespace = '<candidate>' AND writable = 0)"
   ```

   删除后必须确认 changes = 1。若为 0，说明 namespace 已 reopen、已不再冻结或 marker 已变化；此时禁止 marker 回滚，只能向前恢复。

2. 重新部署已记录的 known-good deployment。
3. 仅在 expand-only 迁移之外确有 D1 数据损坏时，按步骤 1 的 bookmark 使用 D1 Time Travel；不要为了删除空的新表而恢复整个数据库。
4. 保留 candidate generation、namespace、报告和附件租约用于调查，不要手工删除。

## 回滚窗口关闭与 legacy 收缩

当前仓库尚未满足立即删除全部兼容代码的条件。关闭窗口前必须确认：

- 生产稳定运行超过批准窗口，且 canonical 写入/导出证据完整；
- 没有依赖 `app_data` 或 legacy YAML 的外部消费者；
- REST mutation 已直接操作 Proto，不再执行 Proto → DTO → converter → Proto；
- 附件租约已到期且对象可达性审计通过；
- 产品、数据、运维负责人明确签字。

签字后用以下搜索建立删除清单，并在独立变更中删除：

```bash
rg -n "createD1Store|convertLegacyToV1alpha1|projectCanonicalToRest|yamlExport|app_data|requirement_yaml_v0|task_sop_yaml_v0" server functions src shared tests
```

`shared/transport/restDto.ts`、legacy converter、旧 exporter fallback 和 `app_data` writer 都是当前有意保留的 rollback/适配边界，不应在本次 prepare/cutover 变更中提前删除。
