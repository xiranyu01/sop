import { expect, test } from '@playwright/test';
import { password } from './helpers/app';

test('locked shell rejects a wrong password, unlocks, persists refresh, and exposes all destinations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'SOP 需求管理' })).toBeVisible();

  await page.getByLabel('访问密码').fill('wrong-password');
  await page.getByRole('button', { name: '进入系统' }).click();
  await expect(page.getByText('访问密码无效或已过期')).toBeVisible();

  await page.getByLabel('访问密码').fill(password);
  await page.getByRole('button', { name: '进入系统' }).click();
  await expect(page.getByRole('heading', { name: '客户需求管理' })).toBeVisible();

  for (const destination of ['客户需求', '场景库', '客户', '物料', '机器型号', '全局字段']) {
    await expect(page.getByRole('button', { name: new RegExp(`^${destination}\\s+\\d+$`) })).toBeVisible();
  }

  await page.getByRole('button', { name: /^物料/ }).click();
  await expect(page.getByRole('heading', { name: '物料信息' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '物料信息' })).toBeVisible();

  await page.evaluate(() => window.localStorage.removeItem('sop-manager-api-password'));
  await page.reload();
  await expect(page.getByLabel('访问密码')).toBeVisible();
});
