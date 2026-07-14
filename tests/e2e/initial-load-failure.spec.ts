import { expect, test } from '@playwright/test';
import { password } from './helpers/app';

test('an authoritative first-page failure blocks editing until an explicit retry succeeds', async ({ page }) => {
  let failCustomerList = true;
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
    key: 'sop-manager-api-password',
    value: password,
  });
  await page.route('**/api/resources/customers*', async (route) => {
    const url = new URL(route.request().url());
    if (failCustomerList && url.pathname === '/api/resources/customers') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            kind: 'STORAGE_UNAVAILABLE',
            message: 'E2E authoritative customer page unavailable',
            details: { retryable: true },
          },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '暂时无法加载业务数据' })).toBeVisible();
  await expect(page.getByText('E2E authoritative customer page unavailable')).toBeVisible();
  await expect(page.getByText('为避免覆盖现有数据，编辑功能已停用')).toBeVisible();
  await expect(page.locator('input, textarea, select')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /新建/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^客户\s+\d+$/ })).toHaveCount(0);

  failCustomerList = false;
  const recoveredList = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/resources/customers' && response.status() === 200);
  await page.getByRole('button', { name: '重新加载' }).click();
  await recoveredList;
  await expect(page.getByRole('heading', { name: '客户需求管理' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^客户\s+\d+$/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: '暂时无法加载业务数据' })).toHaveCount(0);
});
