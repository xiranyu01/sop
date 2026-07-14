# Deployment, bootstrap, and recovery

This runbook covers the fresh resource-scoped D1 schema. It does not migrate a
previous runtime database: the site has not entered production, so each
environment is initialized once from the reviewed repository fixtures.

## Environment boundary

Local, preview, and production must use different Cloudflare resources:

| Environment | D1 | R2 | secrets | bootstrap marker |
| --- | --- | --- | --- | --- |
| Local/E2E | isolated Wrangler persistence directory | isolated test bucket | ignored `.dev.vars` or CI store | local database only |
| Preview | preview database | preview bucket | Cloudflare preview secrets | preview database only |
| Production | production database | production bucket | Cloudflare production secrets | production database only |

Required runtime bindings are `DB` and `APP_PASSWORD`; attachment deployments
also bind their environment's R2 bucket. The bootstrap operator uses
`CLOUDFLARE_ACCOUNT_ID` (or `CF_ACCOUNT_ID`), `CLOUDFLARE_API_TOKEN` (or
`CF_API_TOKEN`), and the target database UUID through `--database-id` or
`SOP_D1_DATABASE_ID`. Keep the API token in the operator's secret store. Do not
put credentials in a command line, tracked env file, log, or support bundle.

## Release order: schema, bootstrap, readiness, deploy

Run all commands from the exact checkout being deployed.

1. Inspect the release's fixed bootstrap identity:

   ```bash
   pnpm exec tsx server/bootstrap/cli.ts manifest --fixture-dir data
   pnpm exec tsx server/bootstrap/cli.ts bootstrap --fixture-dir data --dry-run
   ```

   Dry-run must report `validated: true`. It fails if the fixture digest or
   expected independent-record counts differ from
   `server/bootstrap/releaseManifest.ts`. A fixture change therefore requires a
   reviewed manifest update in the same release; runtime code never calculates
   this identity from fixture files.

2. Apply the versioned D1 schema to the selected environment:

   ```bash
   pnpm exec wrangler d1 migrations apply sop-preview --remote --env preview
   ```

   Substitute the configured production database and environment only after the
   preview run succeeds. Do not create `app_data`, snapshot, generation, or
   namespace tables.

3. Run the one-time operator bootstrap against that database UUID:

   ```bash
   pnpm exec tsx server/bootstrap/cli.ts bootstrap --fixture-dir data --database-id "$PREVIEW_DATABASE_ID"
   ```

   Bootstrap explicitly reads the fixture directory, converts it into separate
   catalog, current-resource, revision, checkpoint, and sealed-bundle records,
   and claims `SOP_META.repository.bootstrap` with
   `EMPTY -> IN_PROGRESS -> COMPLETE` compare-and-set transitions. It never
   overwrites a differing row. A retry with the same digest fills only missing
   records and may finalize an interrupted run; a different digest/version is a
   hard failure.

4. Verify the exact release marker and repository projection integrity:

   ```bash
   pnpm exec tsx server/bootstrap/cli.ts status --database-id "$PREVIEW_DATABASE_ID"
   ```

   Success requires the exact `COMPLETE` schema version, bootstrap version,
   fixture digest, record counts, canonical marker encoding, and a passing
   Proto-to-column parity audit. Missing schema, missing/incomplete/mismatched
   bootstrap, D1 failure, or corrupt projections must remain blocking.

5. Deploy, then check the public payload-free `GET /api/health` and the
   authenticated `GET /api/readiness`. Run the critical create/edit/confirm and
   frozen YAML/PDF export smoke tests. Restart the Pages runtime without
   re-running bootstrap and repeat readiness plus a persisted resource/export
   read. A restart must read only D1/R2; it must work even when repository
   fixture files are unavailable to the runtime.

Never add bootstrap to server startup, request handling, deployment hooks, or an
initial-page fallback. A non-ready database must produce a durable non-editable
UI state, not an empty writable application.

## Interrupted bootstrap

- `IN_PROGRESS` with the same release manifest: rerun the same bootstrap command.
  Existing records are compared and left unchanged; missing records are added.
- `IN_PROGRESS` or `COMPLETE` with a different digest/version: stop. Confirm the
  environment and checkout. Do not edit the marker or force an overwrite.
- Same key with different content, invalid references, oversized rows, or parity
  failure: preserve the database for diagnosis. Fix the fixture/converter or use
  a new empty environment; do not mark it complete manually.
- `COMPLETE` but status fails integrity: stop writes and use D1 recovery. Running
  bootstrap again is not a repair mechanism because complete records are
  immutable and conflicts fail closed.

## D1 Time Travel recovery

D1 Time Travel is the structured-data recovery boundary. It does not recover R2
bytes or act as an old-format migration rollback.

1. Stop application writes to the affected environment and record the incident
   start and last-known-good RFC3339 timestamps.
2. Ask D1 for the recovery bookmark and save the JSON output in the incident
   record:

   ```bash
   pnpm exec wrangler d1 time-travel info sop-prod --timestamp 2026-07-14T10:00:00Z --json
   ```

3. Restore only after a second operator confirms the database/environment and
   bookmark:

   ```bash
   pnpm exec wrangler d1 time-travel restore sop-prod --bookmark "$D1_BOOKMARK"
   ```

4. Run the bootstrap `status` command from the deployed release. Verify the
   marker is the exact expected `COMPLETE` value and the integrity audit passes.
   Then run read-only resource, revision, and frozen-export smoke checks.
5. Re-enable writes, restart Pages, and repeat readiness and persistence checks.

If the selected restore point predates initialization, create a new empty
database and follow the normal schema/bootstrap sequence. Do not copy an old
site-wide document or hand-edit resource rows.

## Attachment tradeoff

This release intentionally has no attachment lifecycle manager or physical
cleanup. D1 stores stable attachment identity, immutable server-owned object
keys, bounded upload metadata, and an optional syntactically valid HTTPS public
URL; R2 stores bytes. Unlinking attachment metadata does not delete the R2
object. Confirmation and export do not make live R2/URL/hash/size consistency
checks.

Consequences:

- Unlinked objects may remain in R2 and accrue storage cost.
- D1 Time Travel may restore metadata references; it does not restore a manually
  deleted R2 object.
- Operators must not run ad-hoc orphan cleanup as part of deployment or
  recovery. Inventory/cleanup policy is deferred to a later release.

## Completion record

For each environment, record the git revision, migration output, fixed release
manifest, bootstrap/status output, deployment id, smoke-test result, restart
result, and operator/time. Do not include credentials, request bodies, ProtoJSON,
fixture contents, or attachment bytes.
