import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import YAML from 'yaml';
import type {
  ConfirmationResult,
  DependencyReviewResult,
  ResourceMutationResult,
  ResourceSummary,
  RevisionSummary,
} from '../../shared/transport/resourceDto';
import {
  apiJson,
  authHeaders,
  cloneResourceForCreate,
  createResource,
  firstResource,
  getResource,
  installPrintObserver,
  listResourceSummaries,
  listRevisions,
  openAuthenticated,
  resourcePath,
  waitForPrintedDocument,
} from './helpers/app';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('TaskSop draft → review → confirm → export → next draft → restore lifecycle remains stable', async ({ page, request }, testInfo) => {
  await installPrintObserver(page);
  const title = `E2E 生命周期 SOP R${testInfo.retry}`;
  const template = await firstResource(request, 'taskSops', (item) => !item.archived);
  const templateProto = template.resource;
  if (!templateProto || typeof templateProto !== 'object' || Array.isArray(templateProto) || typeof templateProto.scene !== 'string') {
    throw new TypeError('TaskSop template must identify its Scene');
  }
  const scene = (await listResourceSummaries(request, 'scenes')).find((item) => item.name === templateProto.scene);
  expect(scene, `Expected Scene ${templateProto.scene}`).toBeDefined();
  const draft = await createResource(request, 'taskSops', cloneResourceForCreate(template.resource, {
    displayName: title,
    description: '资源级 E2E 生命周期',
    sourceId: `e2e-task-r${testInfo.retry}`,
    legacySubsceneCode: `E2E-R${testInfo.retry}`,
    legacySubsceneDisplayName: title,
    lifecycle: 'LIFECYCLE_DRAFT',
  }));
  expect(draft).toMatchObject({
    name: `taskSops/e2e-task-r${testInfo.retry}`,
    lifecycle: 'DRAFT',
    resource: { displayName: title, candidateVersionLabel: '1.0.0' },
  });

  await openAuthenticated(page);
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', {
    name: new RegExp(`^${escapeRegex(scene!.displayName)}\\s+\\d+ 个任务 SOP$`),
  }).click();
  await page.getByRole('button', { name: new RegExp(`^${title} v1\\.0\\.0 · 草稿$`) }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  const rootPath = resourcePath('taskSops', draft.name);
  const review = await apiJson<DependencyReviewResult>(request, 'POST', `${rootPath}/review-proposal`, {
    expectedEtag: draft.etag,
  });
  expect(review).toMatchObject({ rootName: draft.name, rootEtag: draft.etag });

  const blockedConfirmation = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `${rootPath}/confirmations` && response.request().method() === 'POST');
  const acknowledgement = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `${rootPath}/review-acknowledgements` && response.request().method() === 'POST');
  const dialogPromise = page.waitForEvent('dialog');
  const firstConfirmClick = page.getByRole('button', { name: '确认任务 SOP' }).click();
  const dialog = await dialogPromise;
  expect(dialog.message()).toContain('确认冻结当前直接依赖');
  await dialog.accept();
  await firstConfirmClick;
  expect((await blockedConfirmation).status()).toBe(409);
  expect((await acknowledgement).ok()).toBe(true);

  const confirmedResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `${rootPath}/confirmations` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '确认任务 SOP' }).click();
  const confirmationResponse = await confirmedResponse;
  expect(confirmationResponse.ok()).toBe(true);
  const confirmed = await confirmationResponse.json() as ConfirmationResult;
  expect(confirmed).toMatchObject({
    resource: { name: draft.name, lifecycle: 'CONFIRMED' },
    revision: { versionLabel: '1.0.0', exportEligible: true },
    idempotent: false,
  });
  expect(confirmed.exportPath).toBe(`/api/revisions/${encodeURIComponent(confirmed.revision.name)}/export.yaml`);
  await expect(page.getByText('任务 SOP 版本已确认')).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', {
    name: new RegExp(`^${escapeRegex(scene!.displayName)}\\s+\\d+ 个任务 SOP$`),
  }).click();
  await page.getByRole('button', { name: new RegExp(`^${title} v1\\.0\\.0 · 已确认$`) }).click();
  await expect(page.getByText('当前任务 SOP 已确认')).toBeVisible();

  await page.getByRole('button', { name: '导出' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 YAML' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.yaml$/);
  const path = await download.path();
  expect(path).toBeTruthy();
  expect(YAML.parse(await readFile(path!, 'utf8'))).toEqual(expect.objectContaining({
    format: 'coscene.sop.export', schema_version: '1.0.0', root: expect.objectContaining({ kind: 'task_sop' }),
  }));

  await page.getByRole('button', { name: '导出' }).click();
  await page.getByRole('button', { name: '导出 PDF' }).click();
  const pdfFrame = page.frameLocator('iframe[title$=".pdf"]');
  await expect(pdfFrame.locator('body')).toContainText(title);
  await expect(pdfFrame.locator('body')).toContainText('1.0.0');
  expect((await waitForPrintedDocument(page, title)).text).toContain('1.0.0');

  const draftPath = `${resourcePath('taskSops', draft.name)}/drafts`;
  const createDraftResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === draftPath && response.request().method() === 'POST');
  await page.getByRole('button', { name: '编辑为草稿' }).click();
  const createdDraftResponse = await createDraftResponse;
  expect(createdDraftResponse.ok()).toBeTruthy();
  const createdDraft = await createdDraftResponse.json() as ResourceMutationResult;
  expect(createdDraft.resource.resource).toMatchObject({ candidateVersionLabel: '1.0.1' });
  await expect(page.getByText('已创建草稿版本')).toBeVisible();
  await expect(page.getByLabel('版本')).toHaveValue('1.0.1');

  const deleteDraftResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === draftPath && response.request().method() === 'DELETE');
  await page.getByRole('button', { name: '删除草稿' }).click();
  expect((await deleteDraftResponse).ok()).toBeTruthy();
  await expect(page.getByText('草稿版本已删除')).toBeVisible();
  await expect(page.getByLabel('版本')).toHaveValue('1.0.0');
  await expect(page.getByText('当前任务 SOP 已确认')).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', {
    name: new RegExp(`^${escapeRegex(scene!.displayName)}\\s+\\d+ 个任务 SOP$`),
  }).click();
  await page.getByRole('button', { name: new RegExp(`^${title} v1\\.0\\.0 · 已确认$`) }).click();
  await expect(page.getByLabel('版本').locator('option')).toHaveCount(1);
  await expect(page.getByText('当前任务 SOP 已确认')).toBeVisible();
  await expect(getResource(request, 'taskSops', draft.name)).resolves.toMatchObject({ lifecycle: 'CONFIRMED' });
  await expect(listRevisions(request, 'taskSops', draft.name)).resolves.toEqual([
    expect.objectContaining({ name: confirmed.revision.name, versionLabel: '1.0.0', exportEligible: true }),
  ]);
});

test('legacy draft checkpoints remain visible, read-only, and export-ineligible', async ({ page, request }) => {
  const roots = await listResourceSummaries(request, 'taskSops');
  let checkpoint: RevisionSummary | undefined;
  let checkpointRoot: ResourceSummary | undefined;
  for (const root of roots) {
    checkpoint = (await listRevisions(request, 'taskSops', root.name)).find((revision) =>
      revision.origin.endsWith('IMPORTED_DRAFT_CHECKPOINT') && !revision.exportEligible);
    if (checkpoint) {
      checkpointRoot = root;
      break;
    }
  }
  expect(checkpoint, 'Expected the repository fixture to retain at least one legacy TaskSop draft checkpoint').toBeDefined();
  expect(checkpointRoot?.sceneName, 'Expected the checkpoint TaskSop summary to identify its Scene').toBeTruthy();

  const scene = (await listResourceSummaries(request, 'scenes')).find((item) => item.name === checkpointRoot!.sceneName);
  expect(scene, `Expected Scene ${checkpointRoot!.sceneName}`).toBeDefined();
  await openAuthenticated(page);
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', {
    name: new RegExp(`^${escapeRegex(scene!.displayName)}\\s+\\d+ 个任务 SOP$`),
  }).click();
  await page.getByRole('button', {
    name: new RegExp(`^${escapeRegex(checkpointRoot!.displayName)} v`),
  }).first().click();
  await page.getByLabel('版本').selectOption(checkpoint!.versionLabel);
  await expect(page.getByText('这是迁移保留的旧草稿检查点，仅供追踪，不能编辑、确认或导出。')).toBeVisible();
  await expect(page.getByText('导入草稿检查点（只读）')).toBeVisible();
  await expect(page.getByLabel('任务 SOP 名称')).toBeDisabled();
  await expect(page.getByRole('button', { name: '确认任务 SOP' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '删除草稿' })).toHaveCount(0);
  await page.getByRole('button', { name: '导出' }).click();
  await expect(page.getByRole('button', { name: '导出 YAML' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '导出 PDF' })).toBeDisabled();

  const response = await request.get(`/api/revisions/${encodeURIComponent(checkpoint!.name)}/export.yaml`, {
    headers: authHeaders,
  });
  expect(response.status()).toBe(409);
  await expect(response.json()).resolves.toMatchObject({ error: { kind: 'IMMUTABLE_REVISION' } });
});

test('revision export is addressed only by the canonical encoded revision name', async ({ request }) => {
  const roots = await listResourceSummaries(request, 'taskSops');
  let revision: RevisionSummary | undefined;
  for (const root of roots) {
    revision = (await listRevisions(request, 'taskSops', root.name)).find((item) => item.exportEligible);
    if (revision) break;
  }
  expect(revision, 'Expected an exportable TaskSop fixture revision').toBeDefined();

  const yaml = await request.get(`/api/revisions/${encodeURIComponent(revision!.name)}/export.yaml`, {
    headers: authHeaders,
  });
  expect(yaml.ok()).toBe(true);
  expect(yaml.headers()['content-type']).toContain('application/yaml');
  expect(YAML.parse(await yaml.text())).toEqual(expect.objectContaining({
    format: 'coscene.sop.export', root: expect.objectContaining({ kind: 'task_sop' }),
  }));

  const detail = await apiJson<{ name: string; ownerName: string }>(
    request,
    'GET',
    `/api/revisions/${encodeURIComponent(revision!.name)}`,
  );
  expect(detail.name).toBe(revision!.name);
  expect(revision!.name.startsWith(`${detail.ownerName}/revisions/`)).toBe(true);
});
