import { expect, test } from '@playwright/test';
import type { AppData, Customer, GlobalField, Material, RobotModel } from '../../shared/transport/restDto';
import { apiJson, openAuthenticated } from './helpers/app';

test('customer create/edit persists after reload and remains searchable', async ({ page }) => {
  await openAuthenticated(page);
  await page.getByRole('button', { name: /^客户\s+\d+$/ }).click();
  await page.getByRole('button', { name: '新建客户' }).click();
  await page.getByLabel('客户名称').fill('E2E 新客户');
  await page.getByLabel('联系人').fill('Alice');
  await page.getByLabel('电话').fill('13800000000');
  await page.getByLabel('邮箱').fill('alice@example.test');
  await page.getByLabel('备注').fill('浏览器创建');
  const saveResponse = page.waitForResponse((response) => response.url().endsWith('/api/customers') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '保存客户' }).click();
  expect((await saveResponse).ok()).toBe(true);
  await page.getByRole('button', { name: '关闭' }).click();

  await page.reload();
  await page.getByPlaceholder('搜索客户名称、编号或字段').fill('E2E 新客户');
  await expect(page.getByRole('button', { name: /E2E 新客户/ })).toBeVisible();
});

test('master-data APIs preserve CRUD fields and reject duplicate material SKU', async ({ request }) => {
  const customers = await apiJson<Customer[]>(request, 'POST', '/api/customers', {
    id: 'cus-api', name: 'API 客户', contact: { name: 'Bob', phone: '1', email: 'bob@example.test' }, notes: 'updated',
  });
  expect(customers.find((item) => item.id === 'cus-api')?.notes).toBe('updated');

  const materials = await apiJson<Material[]>(request, 'POST', '/api/materials', {
    id: 'mat-api', skuId: 'SKU900', type: 'API 物料', color: '黑', material: '金属', packageType: '箱装', size: '1m', weight: '1kg',
  });
  expect(materials.find((item) => item.id === 'mat-api')?.size).toBe('1m');
  const duplicate = await request.post('/api/materials', {
    headers: { Authorization: 'Bearer e2e-password' },
    data: { id: 'mat-duplicate', skuId: 'SKU900', type: '重复物料' },
  });
  expect(duplicate.status()).toBe(400);
  await expect(duplicate.json()).resolves.toMatchObject({ message: 'SKU 编号 SKU900 已存在' });

  const robots = await apiJson<RobotModel[]>(request, 'POST', '/api/robot-models', {
    id: 'robot-api', brand: 'API', model: 'R1', terminal: '夹爪', topics: { camera: '/rgb' }, extraTopicRequirements: { camera: '30fps' },
  });
  expect(robots.find((item) => item.id === 'robot-api')?.extraTopicRequirements.camera).toBe('30fps');

  const fields = await apiJson<GlobalField[]>(request, 'POST', '/api/global-fields', {
    id: 'field-api', group: 'pose', label: '直立', value: '直立', status: 'inactive', description: 'API fixture',
  });
  expect(fields.find((item) => item.id === 'field-api')?.status).toBe('inactive');

  const data = await apiJson<AppData>(request, 'GET', '/api/data');
  expect(data.customers.some((item) => item.id === 'cus-api')).toBe(true);
  expect(data.materials.some((item) => item.id === 'mat-api')).toBe(true);
});
