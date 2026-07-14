import { expect, test } from '@playwright/test';
import YAML from 'yaml';
import type { Requirement } from '../../shared/transport/restDto';
import { apiJson, authHeaders, openAuthenticated } from './helpers/app';

test('Requirement create → update → confirm → patch draft → delete and TaskSop navigation remain stable', async ({ page, request }, testInfo) => {
  const title = `E2E 关联需求 R${testInfo.retry}`;
  let requirements = await apiJson<Requirement[]>(request, 'POST', '/api/requirements', {
    title,
    projectName: 'E2E 项目',
    customerId: 'cus-baseline',
    robotModelId: 'robot-baseline',
    selectedSubscenes: [{
      id: 'pri-e2e', title: '基线生产项', description: '用于跨页导航', sceneName: '基线场景', targetDurationHours: 1,
      targetCollectionCount: 2,
      taskSop: { sceneName: '基线场景', title: '基线任务 SOP', version: '0.0.1', status: 'confirmed' },
    }],
  });
  const requirement = requirements.find((item) => item.versions[0].title === title)!;
  expect(requirement.versions[0].status).toBe('draft');

  requirements = await apiJson<Requirement[]>(request, 'PUT', `/api/requirements/${requirement.id}`, {
    baseVersion: '0.0.1', businessGoal: '更新后的业务目标',
  });
  expect(requirements.find((item) => item.id === requirement.id)?.versions[0].businessGoal).toBe('更新后的业务目标');

  requirements = await apiJson<Requirement[]>(request, 'POST', `/api/requirements/${requirement.id}/confirm`, { version: '0.0.1' });
  expect(requirements.find((item) => item.id === requirement.id)?.versions[0].status).toBe('confirmed');
  const exported = await apiJson<{ yaml: string }>(request, 'POST', `/api/requirements/${requirement.id}/export-yaml`, { version: '0.0.1' });
  const exportedDocument = YAML.parse(exported.yaml);
  expect(exportedDocument).toEqual(expect.objectContaining({
    format: 'coscene.sop.export', schema_version: '1.0.0', root: expect.objectContaining({ kind: 'requirement' }),
  }));
  expect(exportedDocument.requirements[0].spec.production_items[0].target.collection_count).toBe('2');
  expect(exportedDocument.task_sops).toHaveLength(1);

  await openAuthenticated(page);
  await page.getByPlaceholder('搜索需求名称、客户、项目').fill(title);
  await page.getByRole('button', { name: new RegExp(title) }).first().click();
  await page.getByRole('button', { name: '查看' }).last().click();
  await expect(page.getByRole('button', { name: '返回需求页' })).toBeVisible();
  await page.getByRole('button', { name: '返回需求页' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  requirements = await apiJson<Requirement[]>(request, 'PUT', `/api/requirements/${requirement.id}`, { baseVersion: '0.0.1' });
  expect(requirements.find((item) => item.id === requirement.id)?.versions.at(-1)?.status).toBe('draft');
  requirements = await apiJson<Requirement[]>(request, 'DELETE', `/api/requirements/${requirement.id}/versions/0.0.2`);
  expect(requirements.find((item) => item.id === requirement.id)?.versions).toHaveLength(1);
});

test('draft Requirement YAML is rejected by the confirmed-only export contract', async ({ request }, testInfo) => {
  const title = `Draft export rejection R${testInfo.retry}`;
  const requirements = await apiJson<Requirement[]>(request, 'POST', '/api/requirements', { title });
  const draft = requirements.find((requirement) => requirement.versions[0].title === title)!;
  const response = await request.post(`/api/requirements/${draft.id}/export-yaml`, {
    headers: authHeaders, data: { version: '0.0.1' },
  });
  expect(response.status()).toBe(400);
  expect((await response.json()).message).toContain('仅支持导出已确认版本');
});
