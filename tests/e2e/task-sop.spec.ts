import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import YAML from 'yaml';
import type { Scene } from '../../shared/transport/restDto';
import { confirmedTaskSop } from './fixtures/seed';
import { apiJson, authHeaders, installPrintObserver, openAuthenticated, waitForPrintedDocument } from './helpers/app';

test('TaskSop draft → confirm → patch draft → delete lifecycle remains stable', async ({ page, request }, testInfo) => {
  await installPrintObserver(page);
  const code = `NO.E2E${testInfo.retry}`;
  const title = `E2E 生命周期 SOP R${testInfo.retry}`;
  const scenes = await apiJson<Scene[]>(request, 'POST', `/api/scenes/scene-baseline/subscenes/${code}/versions`, {
    ...confirmedTaskSop,
    status: 'draft',
    title,
  });
  expect(scenes[0].subscenes.find((item) => item.code === code)?.versions[0].status).toBe('draft');

  await openAuthenticated(page);
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', { name: new RegExp(`^${title} v0\\.0\\.1 · 草稿$`) }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  const confirmResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/scenes/scene-baseline/subscenes/${code}/confirm`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '确认任务 SOP' }).click();
  expect((await confirmResponse).ok()).toBeTruthy();
  await expect(page.getByText('任务 SOP 版本已确认')).toBeVisible();
  await expect(page.getByText('当前任务 SOP 已确认')).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', { name: new RegExp(`^${title} v0\\.0\\.1 · 已确认$`) }).click();
  await expect(page.getByText('当前任务 SOP 已确认')).toBeVisible();
  await page.getByRole('button', { name: '导出' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 YAML' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/E2E.*0\.0\.1\.yaml/);
  const path = await download.path();
  expect(path).toBeTruthy();
  expect(YAML.parse(await readFile(path!, 'utf8'))).toEqual(expect.objectContaining({
    format: 'coscene.sop.export', schema_version: '1.0.0', root: expect.objectContaining({ kind: 'task_sop' }),
  }));
  await page.getByRole('button', { name: '导出' }).click();
  await page.getByRole('button', { name: '导出 PDF' }).click();
  const pdfFrame = page.frameLocator('iframe[title$="-0.0.1.pdf"]');
  await expect(pdfFrame.locator('body')).toContainText(title);
  await expect(pdfFrame.locator('body')).toContainText('0.0.1');
  expect((await waitForPrintedDocument(page, title)).text).toContain('0.0.1');

  const createDraftResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/scenes/scene-baseline/subscenes/${code}/versions`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '编辑为草稿' }).click();
  expect((await createDraftResponse).ok()).toBeTruthy();
  await expect(page.getByText('已创建草稿版本')).toBeVisible();
  await expect(page.getByLabel('版本')).toHaveValue('0.0.2');

  const deleteDraftResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/scenes/scene-baseline/subscenes/${code}/versions/0.0.2`) && response.request().method() === 'DELETE');
  await page.getByRole('button', { name: '删除草稿' }).click();
  expect((await deleteDraftResponse).ok()).toBeTruthy();
  await expect(page.getByText('草稿版本已删除')).toBeVisible();
  await expect(page.getByLabel('版本')).toHaveValue('0.0.1');
  await expect(page.getByText('当前任务 SOP 已确认')).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', { name: new RegExp(`^${title} v0\\.0\\.1 · 已确认$`) }).click();
  await expect(page.getByLabel('版本').locator('option')).toHaveCount(1);
  await expect(page.getByText('当前任务 SOP 已确认')).toBeVisible();
});

test('confirmed TaskSop YAML is delivered as a non-empty browser download', async ({ page }) => {
  await openAuthenticated(page);
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', { name: /基线任务 SOP/ }).first().click();
  await page.getByRole('button', { name: '导出' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 YAML' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/基线任务-SOP-0\.0\.1\.yaml|基线任务.*0\.0\.1\.yaml/);
  const path = await download.path();
  expect(path).toBeTruthy();
  expect(YAML.parse(await readFile(path!, 'utf8'))).toEqual(expect.objectContaining({
    format: 'coscene.sop.export', schema_version: '1.0.0', root: expect.objectContaining({ kind: 'task_sop' }),
  }));
});

test('draft TaskSop YAML is rejected by the confirmed-only export contract', async ({ request }) => {
  const scenes = await apiJson<Scene[]>(request, 'POST', '/api/scenes/scene-baseline/subscenes/NO.001/versions', {
    baseVersion: '0.0.1', description: 'draft export rejection',
  });
  const version = scenes[0].subscenes[0].versions.at(-1)!.version;
  const response = await request.post('/api/scenes/scene-baseline/subscenes/NO.001/export-yaml', {
    headers: authHeaders, data: { version },
  });
  expect(response.status()).toBe(400);
  expect((await response.json()).message).toContain('仅支持导出已确认版本');
});
