import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { ResourceMutationResult } from '../../shared/transport/resourceDto';
import {
  apiJson,
  cloneResourceForCreate,
  createResource,
  firstResource,
  listResourceSummaries,
  openAuthenticated,
  resourcePath,
} from './helpers/app';

test('archives and restores a draft Requirement from the archive library', async ({ page, request }, testInfo) => {
  const title = `E2E 归档需求 R${testInfo.retry}`;
  const template = await firstResource(request, 'requirements', (item) => !item.archived);
  const created = await createResource(request, 'requirements', cloneResourceForCreate(template.resource, {
    displayName: title,
    sourceId: `e2e-archive-requirement-r${testInfo.retry}`,
    lifecycle: 'LIFECYCLE_DRAFT',
  }));

  await page.route('**/api/resources/taskSops?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    });
  });

  await openAuthenticated(page);
  await page.goto(`/requirements/${created.uid}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '归档', exact: true }).click();
  await expect(page.getByRole('heading', { name: '归档库' })).toBeVisible();
  await expect(page.getByText(title, { exact: true })).toBeVisible();

  await page.getByText(title, { exact: true }).click();
  await expect(page.getByText('归档内容只读。')).toBeVisible();
  await expect(page.getByText(/生产需求项未选择任务 SOP/)).toHaveCount(0);
  await page.getByRole('button', { name: '取消归档' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/requirements/${created.uid}$`));
});

test('archives and restores a draft Task SOP under its original Scene', async ({ page, request }, testInfo) => {
  const title = `E2E 归档任务 R${testInfo.retry}`;
  const template = await firstResource(request, 'taskSops', (item) => !item.archived);
  const created = await createResource(request, 'taskSops', cloneResourceForCreate(template.resource, {
    displayName: title,
    sourceId: `e2e-archive-task-r${testInfo.retry}`,
    legacySubsceneCode: `ARCHIVE-R${testInfo.retry}`,
    legacySubsceneDisplayName: title,
    lifecycle: 'LIFECYCLE_DRAFT',
  }));

  await openAuthenticated(page);
  await page.goto(`/task-sops/${created.uid}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '归档', exact: true }).click();
  await expect(page.getByRole('heading', { name: '归档库' })).toBeVisible();
  await page.getByRole('button', { name: '任务 SOP', exact: true }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();

  await page.getByText(title, { exact: true }).click();
  await expect(page.getByText('归档内容只读。')).toBeVisible();
  await page.getByRole('button', { name: '取消归档' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/task-sops/${created.uid}$`));
});

test('warns before a new Requirement reuses an archived display name', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const title = `E2E 同名归档需求 ${suffix}`;
  const template = await firstResource(request, 'requirements', (item) => !item.archived);
  const archivedSource = await createResource(request, 'requirements', cloneResourceForCreate(template.resource, {
    displayName: title,
    sourceId: `e2e-duplicate-requirement-${suffix}`,
    lifecycle: 'LIFECYCLE_DRAFT',
  }));
  await apiJson<ResourceMutationResult>(
    request,
    'POST',
    `${resourcePath('requirements', archivedSource.name)}/archive`,
    { expectedEtag: archivedSource.etag },
  );

  await openAuthenticated(page);
  const createResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/resources/requirements' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '新建需求' }).click();
  expect((await createResponse).status()).toBe(201);
  const nameInput = page.getByLabel('需求名称');

  await nameInput.fill(title);
  const cancelDialogPromise = page.waitForEvent('dialog');
  const cancelBlur = page.getByRole('heading', { name: '基础信息' }).click();
  const cancelDialog = await cancelDialogPromise;
  expect(cancelDialog.message()).toContain(`归档库中已有同名客户需求“${title}”`);
  await cancelDialog.dismiss();
  await cancelBlur;
  await expect(nameInput).toHaveValue('新的客户需求');

  await nameInput.fill(title);
  const saveResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.startsWith('/api/resources/requirements/') &&
    response.request().method() === 'PUT');
  const confirmDialogPromise = page.waitForEvent('dialog');
  const confirmBlur = page.getByRole('heading', { name: '基础信息' }).click();
  await (await confirmDialogPromise).accept();
  await confirmBlur;
  expect((await saveResponse).ok()).toBe(true);
  await expect(nameInput).toHaveValue(title);
});

test('warns before a Task SOP reuses an archived name in the same Scene', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const title = `E2E 同名归档任务 ${suffix}`;
  const template = await firstResource(request, 'taskSops', (item) => !item.archived);
  const templateResource = template.resource;
  if (!templateResource || typeof templateResource !== 'object' || Array.isArray(templateResource) ||
      typeof templateResource.scene !== 'string') {
    throw new TypeError('TaskSop template must identify its Scene');
  }
  const scene = (await listResourceSummaries(request, 'scenes'))
    .find((item) => item.name === templateResource.scene);
  expect(scene).toBeDefined();
  const archivedSource = await createResource(request, 'taskSops', cloneResourceForCreate(templateResource, {
    displayName: title,
    sourceId: `e2e-duplicate-task-${suffix}`,
    legacySubsceneCode: `DUPLICATE-${suffix}`,
    legacySubsceneDisplayName: title,
    lifecycle: 'LIFECYCLE_DRAFT',
  }));
  await apiJson<ResourceMutationResult>(
    request,
    'POST',
    `${resourcePath('taskSops', archivedSource.name)}/archive`,
    { expectedEtag: archivedSource.etag },
  );

  await openAuthenticated(page);
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', { name: new RegExp(`^${scene!.displayName}\\s+\\d+ 个任务 SOP$`) }).click();
  const createResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/resources/taskSops' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '新建任务 SOP' }).click();
  expect((await createResponse).status()).toBe(201);
  const nameInput = page.getByLabel('任务 SOP 名称');

  await nameInput.fill(title);
  const cancelDialogPromise = page.waitForEvent('dialog');
  const cancelBlur = page.getByLabel('任务 SOP 描述').click();
  const cancelDialog = await cancelDialogPromise;
  expect(cancelDialog.message()).toContain(`归档库中已有同名任务 SOP“${title}”`);
  await cancelDialog.dismiss();
  await cancelBlur;
  await expect(nameInput).toHaveValue('新的任务 SOP');

  await nameInput.fill(title);
  const saveResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.startsWith('/api/resources/taskSops/') &&
    response.request().method() === 'PUT');
  const confirmDialogPromise = page.waitForEvent('dialog');
  const confirmBlur = page.getByLabel('任务 SOP 描述').click();
  await (await confirmDialogPromise).accept();
  await confirmBlur;
  expect((await saveResponse).ok()).toBe(true);
  await expect(nameInput).toHaveValue(title);
});

test('blocks a new Requirement from reusing an active display name', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const title = `E2E 同名在用需求 ${suffix}`;
  const template = await firstResource(request, 'requirements', (item) => !item.archived);
  await createResource(request, 'requirements', cloneResourceForCreate(template.resource, {
    displayName: title,
    sourceId: `e2e-active-duplicate-requirement-${suffix}`,
    lifecycle: 'LIFECYCLE_DRAFT',
  }));

  await openAuthenticated(page);
  const createResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/resources/requirements' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '新建需求' }).click();
  expect((await createResponse).status()).toBe(201);
  const nameInput = page.getByLabel('需求名称');
  await nameInput.fill(title);
  const rejectedSave = page.waitForResponse((response) =>
    new URL(response.url()).pathname.startsWith('/api/resources/requirements/') &&
    response.request().method() === 'PUT');
  const alertPromise = page.waitForEvent('dialog');
  const blur = page.getByRole('heading', { name: '基础信息' }).click();
  const alert = await alertPromise;
  expect(alert.message()).toContain('已存在同名客户需求，请使用其他名称');
  await alert.accept();
  await blur;
  expect((await rejectedSave).status()).toBe(409);
  await expect(nameInput).toHaveValue('新的客户需求');
});

test('blocks a new Task SOP from reusing an active name in the same Scene', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const title = `E2E 同名在用任务 ${suffix}`;
  const template = await firstResource(request, 'taskSops', (item) => !item.archived);
  const templateResource = template.resource;
  if (!templateResource || typeof templateResource !== 'object' || Array.isArray(templateResource) ||
      typeof templateResource.scene !== 'string') {
    throw new TypeError('TaskSop template must identify its Scene');
  }
  const scene = (await listResourceSummaries(request, 'scenes'))
    .find((item) => item.name === templateResource.scene);
  expect(scene).toBeDefined();
  await createResource(request, 'taskSops', cloneResourceForCreate(templateResource, {
    displayName: title,
    sourceId: `e2e-active-duplicate-task-${suffix}`,
    legacySubsceneCode: `ACTIVE-DUPLICATE-${suffix}`,
    legacySubsceneDisplayName: title,
    lifecycle: 'LIFECYCLE_DRAFT',
  }));

  await openAuthenticated(page);
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', { name: new RegExp(`^${scene!.displayName}\\s+\\d+ 个任务 SOP$`) }).click();
  const createResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/resources/taskSops' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '新建任务 SOP' }).click();
  expect((await createResponse).status()).toBe(201);
  const nameInput = page.getByLabel('任务 SOP 名称');
  await nameInput.fill(title);
  const rejectedSave = page.waitForResponse((response) =>
    new URL(response.url()).pathname.startsWith('/api/resources/taskSops/') &&
    response.request().method() === 'PUT');
  const alertPromise = page.waitForEvent('dialog');
  const blur = page.getByLabel('任务 SOP 描述').click();
  const alert = await alertPromise;
  expect(alert.message()).toContain('当前场景中已存在同名任务 SOP，请使用其他名称');
  await alert.accept();
  await blur;
  expect((await rejectedSave).status()).toBe(409);
  await expect(nameInput).toHaveValue('新的任务 SOP');
});
