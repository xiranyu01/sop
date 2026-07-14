import { expect, test } from '@playwright/test';
import type { Requirement } from '../../src/types';
import { apiJson, openAuthenticated } from './helpers/app';

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
  const requirement = requirements.at(-1)!;
  expect(requirement.versions[0].status).toBe('draft');

  requirements = await apiJson<Requirement[]>(request, 'PUT', `/api/requirements/${requirement.id}`, {
    baseVersion: '0.0.1', businessGoal: '更新后的业务目标',
  });
  expect(requirements.find((item) => item.id === requirement.id)?.versions[0].businessGoal).toBe('更新后的业务目标');

  requirements = await apiJson<Requirement[]>(request, 'POST', `/api/requirements/${requirement.id}/confirm`, { version: '0.0.1' });
  expect(requirements.find((item) => item.id === requirement.id)?.versions[0].status).toBe('confirmed');

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

test.fixme('draft Requirement YAML is rejected by the confirmed-only export contract', async () => {});
