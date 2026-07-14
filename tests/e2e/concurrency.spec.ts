import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { createResource, getResource, openAuthenticated, resourcePath } from './helpers/app';

function baseUrl(testInfo: TestInfo): string {
  const configured = testInfo.project.use.baseURL;
  return typeof configured === 'string' ? configured : 'http://127.0.0.1:8787';
}

function anchoredRowName(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?:\\s|$)`);
}

async function openCustomerEditor(page: Page, displayName: string): Promise<void> {
  await openAuthenticated(page);
  await page.getByRole('button', { name: /^客户\s+\d+$/ }).click();
  await page.getByPlaceholder('搜索客户名称、编号或字段').fill(displayName);
  await page.getByRole('table').getByRole('button', { name: anchoredRowName(displayName) }).click();
  await expect(page.getByRole('dialog', { name: '客户详情' })).toBeVisible();
}

async function twoContexts(browser: Browser, testInfo: TestInfo) {
  const contextA = await browser.newContext({ baseURL: baseUrl(testInfo) });
  const contextB = await browser.newContext({ baseURL: baseUrl(testInfo) });
  return { contextA, contextB, pageA: await contextA.newPage(), pageB: await contextB.newPage() };
}

test('two browser contexts retain the stale local edit and expose explicit conflict recovery actions', async ({ browser, request }, testInfo) => {
  const displayName = `E2E 并发客户 R${testInfo.retry}`;
  const customer = await createResource(request, 'customers', {
    displayName,
    sourceId: `e2e-concurrency-r${testInfo.retry}`,
    notes: '并发基线',
  });
  const { contextA, contextB, pageA, pageB } = await twoContexts(browser, testInfo);
  try {
    await Promise.all([
      openCustomerEditor(pageA, displayName),
      openCustomerEditor(pageB, displayName),
    ]);
    await expect(pageA.getByLabel('备注')).toHaveValue('并发基线');
    await expect(pageB.getByLabel('备注')).toHaveValue('并发基线');

    const firstSave = pageA.waitForResponse((response) =>
      new URL(response.url()).pathname === resourcePath('customers', customer.name) &&
      response.request().method() === 'PUT');
    await pageA.getByLabel('备注').fill('上下文 A 已保存');
    await pageA.getByRole('button', { name: '保存客户' }).click();
    expect((await firstSave).status()).toBe(200);

    const staleSave = pageB.waitForResponse((response) =>
      new URL(response.url()).pathname === resourcePath('customers', customer.name) &&
      response.request().method() === 'PUT');
    await pageB.getByLabel('备注').fill('上下文 B 本地保留');
    await pageB.getByRole('button', { name: '保存客户' }).click();
    expect((await staleSave).status()).toBe(409);

    await expect(pageB.getByText(customer.name, { exact: true })).toBeVisible();
    await expect(pageB.getByRole('button', { name: '复制本地修改' })).toBeVisible();
    await expect(pageB.getByRole('button', { name: '加载服务器版本' })).toBeVisible();
    await expect(pageB.getByRole('button', { name: '覆盖最新版本' })).toHaveCount(0);
    await expect(pageB.getByLabel('备注')).toHaveValue('上下文 B 本地保留');

    await expect(getResource(request, 'customers', customer.name)).resolves.toMatchObject({
      resource: { notes: '上下文 A 已保存' },
    });

    const reloadConfirmationPromise = pageB.waitForEvent('dialog');
    const reloadClick = pageB.getByRole('button', { name: '加载服务器版本' }).click();
    const reloadConfirmation = await reloadConfirmationPromise;
    expect(reloadConfirmation.message()).toContain('确定丢弃本地修改并重新加载服务器版本吗');
    await reloadConfirmation.accept();
    await reloadClick;
    await expect(pageB.getByLabel('备注')).toHaveValue('上下文 A 已保存');
    await expect(pageB.getByRole('button', { name: '复制本地修改' })).toHaveCount(0);
    await expect(pageB.getByRole('button', { name: '加载服务器版本' })).toHaveCount(0);
  } finally {
    await Promise.all([contextA.close(), contextB.close()]);
  }
});

test('concurrent saves to different resource names remain independent', async ({ browser, request }, testInfo) => {
  const suffix = `r${testInfo.retry}`;
  const [customerA, customerB] = await Promise.all([
    createResource(request, 'customers', {
      displayName: `E2E 独立资源 A ${suffix}`,
      sourceId: `e2e-independent-a-${suffix}`,
      notes: 'A baseline',
    }),
    createResource(request, 'customers', {
      displayName: `E2E 独立资源 B ${suffix}`,
      sourceId: `e2e-independent-b-${suffix}`,
      notes: 'B baseline',
    }),
  ]);
  const { contextA, contextB, pageA, pageB } = await twoContexts(browser, testInfo);
  try {
    await Promise.all([
      openCustomerEditor(pageA, customerA.displayName),
      openCustomerEditor(pageB, customerB.displayName),
    ]);
    await Promise.all([
      pageA.getByLabel('备注').fill('A independent update'),
      pageB.getByLabel('备注').fill('B independent update'),
    ]);
    const responseA = pageA.waitForResponse((response) =>
      new URL(response.url()).pathname === resourcePath('customers', customerA.name) &&
      response.request().method() === 'PUT');
    const responseB = pageB.waitForResponse((response) =>
      new URL(response.url()).pathname === resourcePath('customers', customerB.name) &&
      response.request().method() === 'PUT');
    await Promise.all([
      pageA.getByRole('button', { name: '保存客户' }).click(),
      pageB.getByRole('button', { name: '保存客户' }).click(),
    ]);
    expect((await responseA).status()).toBe(200);
    expect((await responseB).status()).toBe(200);
    await expect(getResource(request, 'customers', customerA.name)).resolves.toMatchObject({
      resource: { notes: 'A independent update' },
    });
    await expect(getResource(request, 'customers', customerB.name)).resolves.toMatchObject({
      resource: { notes: 'B independent update' },
    });
  } finally {
    await Promise.all([contextA.close(), contextB.close()]);
  }
});
