import { expect, test } from '@playwright/test';
import type { ResourceMutationResult } from '../../shared/transport/resourceDto';
import {
  apiJson,
  authHeaders,
  createResource,
  getResource,
  listResourceSummaries,
  listRevisions,
  openAuthenticated,
  resourcePath,
  updateResource,
} from './helpers/app';

function anchoredRowName(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?:\\s|$)`);
}

test('customer create/edit persists after reload and remains searchable', async ({ page }, testInfo) => {
  const customerName = `E2E 新客户 R${testInfo.retry}`;
  await openAuthenticated(page);
  await page.getByRole('button', { name: /^客户\s+\d+$/ }).click();
  await page.getByRole('button', { name: '新建客户' }).click();
  await page.getByLabel('客户名称').fill(customerName);
  await page.getByLabel('联系人').fill('Alice');
  await page.getByLabel('电话').fill('13800000000');
  await page.getByLabel('邮箱').fill('alice@example.test');
  await page.getByLabel('备注').fill('浏览器创建');
  const saveResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/resources/customers' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '保存客户' }).click();
  expect((await saveResponse).status()).toBe(201);
  await page.getByRole('button', { name: '关闭' }).click();

  await page.reload();
  await page.getByPlaceholder('搜索客户名称、编号或字段').fill(customerName);
  await expect(page.getByRole('button', { name: new RegExp(customerName) })).toBeVisible();
});

test('RobotModel edit is submitted by the page and persists through the resource API', async ({ page, request }, testInfo) => {
  const suffix = `w${testInfo.workerIndex}-r${testInfo.retry}`;
  const modelCode = `E2E-ROBOT-UI-${suffix}`;
  const displayName = `E2E Robot UI ${suffix}`;
  const robot = await createResource(request, 'robotModels', {
    displayName,
    sourceId: `e2e-robot-ui-${suffix}`,
    manufacturer: 'E2E',
    modelCode,
    endEffector: '基线末端',
    topics: [{ id: 'camera', topic: `/e2e/${suffix}/camera` }],
    extraTopicRequirements: [{ topicId: 'camera', requirement: '30fps' }],
  });
  const endEffector = `E2E 末端 R${testInfo.retry}`;

  await openAuthenticated(page);
  await page.getByRole('button', { name: /^机器型号\s+\d+$/ }).click();
  await page.getByPlaceholder('搜索机器型号名称、编号或字段').fill(modelCode);
  await page.getByRole('table').getByRole('button', { name: anchoredRowName(displayName) }).click();
  const dialog = page.getByRole('dialog', { name: '机器型号详情' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('末端').fill(endEffector);

  const updateResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === resourcePath('robotModels', robot.name) &&
    response.request().method() === 'PUT');
  await dialog.getByRole('button', { name: '保存型号' }).click();
  expect((await updateResponse).status()).toBe(200);
  await expect(getResource(request, 'robotModels', robot.name)).resolves.toMatchObject({
    resource: { modelCode, endEffector },
  });
});

test('GlobalField edit is submitted by the field dialog and persists', async ({ page, request }, testInfo) => {
  const suffix = `w${testInfo.workerIndex}-r${testInfo.retry}`;
  const label = `E2E 参照物字段 ${suffix}`;
  const field = await createResource(request, 'globalFields', {
    sourceId: `e2e-reference-field-${suffix}`,
    group: 'GLOBAL_FIELD_GROUP_REFERENCE_OBJECT',
    label,
    value: label,
    status: 'GLOBAL_FIELD_STATUS_ACTIVE',
    description: 'E2E 字段基线说明',
  });
  const description = `E2E 字段说明 R${testInfo.retry}`;

  await openAuthenticated(page);
  await page.getByRole('button', { name: /^全局字段\s+\d+$/ }).click();
  await page.getByPlaceholder('搜索字段名称或说明').fill(label);
  await page.getByRole('table').getByRole('button', { name: anchoredRowName(label) }).click();
  const dialog = page.getByRole('dialog', { name: '字段详情' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('说明').fill(description);

  const updateResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === resourcePath('globalFields', field.name) &&
    response.request().method() === 'PUT');
  await dialog.getByRole('button', { name: '保存字段' }).click();
  expect((await updateResponse).status()).toBe(200);
  await expect(getResource(request, 'globalFields', field.name)).resolves.toMatchObject({
    resource: { label, description },
  });
});

test('resource APIs allocate identity, use ETags, project summaries, and append RobotModel revisions', async ({ request }, testInfo) => {
  const suffix = `r${testInfo.retry}`;
  const customer = await createResource(request, 'customers', {
    displayName: `API 客户 ${suffix}`,
    sourceId: `e2e-customer-${suffix}`,
    primaryContact: { displayName: 'Bob', phone: '1', email: 'bob@example.test' },
    notes: 'created',
  });
  expect(customer).toMatchObject({
    name: `customers/e2e-customer-${suffix}`,
    uid: expect.stringMatching(/^[a-f0-9-]{36}$/),
    archived: false,
    resource: { displayName: `API 客户 ${suffix}`, notes: 'created' },
  });

  const customerProto = structuredClone(customer.resource);
  if (!customerProto || typeof customerProto !== 'object' || Array.isArray(customerProto)) {
    throw new TypeError('Customer resource must be an object');
  }
  customerProto.notes = 'updated through expectedEtag';
  const updatedCustomer = await updateResource(request, 'customers', customer, customerProto);
  expect(updatedCustomer.etag).not.toBe(customer.etag);
  expect(updatedCustomer.resource).toMatchObject({ notes: 'updated through expectedEtag' });

  const stale = await request.put(resourcePath('customers', customer.name), {
    headers: authHeaders,
    data: { expectedEtag: customer.etag, resource: updatedCustomer.resource },
  });
  expect(stale.status()).toBe(409);
  await expect(stale.json()).resolves.toMatchObject({ error: { kind: 'STALE_RESOURCE' } });

  const material = await createResource(request, 'materials', {
    displayName: `API 物料 ${suffix}`,
    sourceId: `e2e-material-${suffix}`,
    sku: `SKU-E2E-${suffix}`,
    category: 'API 物料',
    colors: ['黑'],
    compositions: ['金属'],
    packaging: '箱装',
    size: '1m',
    weight: '1kg',
  });
  expect(material.resource).toMatchObject({ size: '1m', weight: '1kg' });

  const robot = await createResource(request, 'robotModels', {
    displayName: `API Robot ${suffix}`,
    sourceId: `e2e-robot-${suffix}`,
    manufacturer: 'API',
    modelCode: 'R1',
    endEffector: '夹爪',
    topics: [{ id: 'camera', topic: '/rgb' }],
    extraTopicRequirements: [{ topicId: 'camera', requirement: '30fps' }],
  });
  expect(robot.currentRevision).toBe(`robotModels/e2e-robot-${suffix}/revisions/v-1-0-0`);
  await expect(listRevisions(request, 'robotModels', robot.name)).resolves.toEqual([
    expect.objectContaining({ name: robot.currentRevision, versionLabel: '1.0.0', exportEligible: false }),
  ]);

  const field = await createResource(request, 'globalFields', {
    sourceId: `e2e-field-${suffix}`,
    group: 'GLOBAL_FIELD_GROUP_POSE',
    label: `直立 ${suffix}`,
    value: `直立 ${suffix}`,
    status: 'GLOBAL_FIELD_STATUS_INACTIVE',
    description: 'API fixture',
  });
  expect(field.resource).toMatchObject({ status: 'GLOBAL_FIELD_STATUS_INACTIVE' });

  const [customers, materials, fields] = await Promise.all([
    listResourceSummaries(request, 'customers'),
    listResourceSummaries(request, 'materials'),
    listResourceSummaries(request, 'globalFields'),
  ]);
  expect(customers).toContainEqual(expect.objectContaining({ name: customer.name }));
  expect(materials).toContainEqual(expect.objectContaining({ name: material.name, sku: `SKU-E2E-${suffix}` }));
  expect(fields).toContainEqual(expect.objectContaining({
    name: field.name,
    fieldGroup: 'GLOBAL_FIELD_GROUP_POSE',
    fieldStatus: 'GLOBAL_FIELD_STATUS_INACTIVE',
  }));

  const archived = await apiJson<ResourceMutationResult>(request, 'POST', `${resourcePath('materials', material.name)}/archive`, {
    expectedEtag: material.etag,
  });
  expect(archived.resource.archived).toBe(true);
  await expect(getResource(request, 'materials', material.name)).resolves.toMatchObject({ archived: true });
});
