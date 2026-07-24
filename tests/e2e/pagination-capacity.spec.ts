import { expect, test, type Request } from '@playwright/test';
import { listResourceSummaries, openAuthenticated, resourcePath } from './helpers/app';

const capacityGlobalFieldCount = 1_200;
const capacityGlobalFieldPrefix = 'zzzz-e2e-capacity';
const globalFieldListPath = '/api/resources/globalFields';
const globalFieldDetailPrefix = `${globalFieldListPath}/`;

function capacityGlobalFieldName(index: number): string {
  return `globalFields/${capacityGlobalFieldPrefix}-${String(index).padStart(4, '0')}`;
}

function anchoredRowName(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?:\\s|$)`);
}

function globalFieldDetailName(request: Request): string | undefined {
  if (request.method() !== 'GET') return undefined;
  const pathname = new URL(request.url()).pathname;
  if (!pathname.startsWith(globalFieldDetailPrefix)) return undefined;
  return decodeURIComponent(pathname.slice(globalFieldDetailPrefix.length));
}

test('GlobalField summaries load the complete catalog without eager-loading the final detail', async ({ page, request }) => {
  const expected = await listResourceSummaries(request, 'globalFields');
  const expectedNames = expected.map((item) => item.name);
  const capacityNames = Array.from(
    { length: capacityGlobalFieldCount },
    (_, index) => capacityGlobalFieldName(index),
  );
  expect(expected.length).toBeGreaterThanOrEqual(1_250);
  expect(expectedNames.filter((name) => name.startsWith(`globalFields/${capacityGlobalFieldPrefix}-`)))
    .toEqual(capacityNames);
  expect(new Set(expectedNames).size).toBe(expectedNames.length);

  const target = expected.at(-1);
  expect(target).toBeDefined();
  expect(target!.name).toBe(capacityNames.at(-1));

  const detailRequests: string[] = [];
  page.on('request', (browserRequest) => {
    const name = globalFieldDetailName(browserRequest);
    if (name) detailRequests.push(name);
  });

  await openAuthenticated(page);
  await page.getByRole('button', { name: /^全局字段\s+\d+$/ }).click();
  await expect(page.getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0);
  expect(detailRequests).not.toContain(target!.name);

  await page.getByPlaceholder('搜索字段名称或说明').fill(target!.displayName);
  const targetRow = page.getByRole('table').getByRole('button', {
    name: anchoredRowName(target!.displayName),
  });
  await expect(targetRow).toBeVisible();

  const detailPath = resourcePath('globalFields', target!.name);
  const detailResponsePromise = page.waitForResponse((response) =>
    response.request().method() === 'GET' && new URL(response.url()).pathname === detailPath);
  await targetRow.click();
  expect((await detailResponsePromise).status()).toBe(200);
  expect(detailRequests.filter((name) => name === target!.name)).toHaveLength(1);

  const dialog = page.getByRole('dialog', { name: '字段详情' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('字段名称')).toHaveValue(target!.displayName);
});
