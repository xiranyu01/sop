import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const password = 'e2e-password';
export const authHeaders = { Authorization: `Bearer ${password}` };

export async function unlock(page: Page) {
  await page.goto('/');
  await page.getByLabel('访问密码').fill(password);
  await page.getByRole('button', { name: '进入系统' }).click();
  await expect(page.getByRole('heading', { name: '客户需求管理' })).toBeVisible();
}

export async function openAuthenticated(page: Page) {
  await page.addInitScript((value) => window.localStorage.setItem('sop-manager-api-password', value), password);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '客户需求管理' })).toBeVisible();
}

export async function apiJson<T>(request: APIRequestContext, method: string, path: string, data?: unknown): Promise<T> {
  const response = await request.fetch(path, { method, headers: authHeaders, data });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.json() as Promise<T>;
}
