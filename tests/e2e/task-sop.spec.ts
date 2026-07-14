import { expect, test } from '@playwright/test';
import type { Scene } from '../../src/types';
import { confirmedTaskSop } from './fixtures/seed';
import { apiJson, openAuthenticated } from './helpers/app';

test('TaskSop draft → confirm → patch draft → delete lifecycle remains stable', async ({ page, request }, testInfo) => {
  const code = `NO.E2E${testInfo.retry}`;
  const title = `E2E 生命周期 SOP R${testInfo.retry}`;
  let scenes = await apiJson<Scene[]>(request, 'POST', `/api/scenes/scene-baseline/subscenes/${code}/versions`, {
    ...confirmedTaskSop,
    status: 'draft',
    title,
  });
  expect(scenes[0].subscenes.find((item) => item.code === code)?.versions[0].status).toBe('draft');

  scenes = await apiJson<Scene[]>(request, 'POST', `/api/scenes/scene-baseline/subscenes/${code}/confirm`, { version: '0.0.1' });
  expect(scenes[0].subscenes.find((item) => item.code === code)?.versions[0].status).toBe('confirmed');

  scenes = await apiJson<Scene[]>(request, 'POST', `/api/scenes/scene-baseline/subscenes/${code}/versions`, {
    baseVersion: '0.0.1', description: '从确认版本创建补丁草稿',
  });
  expect(scenes[0].subscenes.find((item) => item.code === code)?.versions.map((item) => [item.version, item.status])).toEqual([
    ['0.0.1', 'confirmed'], ['0.0.2', 'draft'],
  ]);

  scenes = await apiJson<Scene[]>(request, 'DELETE', `/api/scenes/scene-baseline/subscenes/${code}/versions/0.0.2`);
  expect(scenes[0].subscenes.find((item) => item.code === code)?.versions).toHaveLength(1);

  await openAuthenticated(page);
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', { name: new RegExp(`^${title} v0\\.0\\.1 · 已确认$`) }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
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
});

test.fixme('draft TaskSop YAML is rejected by the confirmed-only export contract', async () => {});
