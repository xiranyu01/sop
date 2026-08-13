import { expect, test, type Page } from '@playwright/test';
import type { JsonValue } from '@bufbuild/protobuf';
import {
  cloneResourceForCreate,
  createResource,
  firstResource,
  getResource,
  listResourceSummaries,
  openAuthenticated,
  resourcePath,
  updateResource,
} from './helpers/app';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function createDraftFixture(request: Parameters<typeof firstResource>[0], title: string, sourceId: string) {
  const template = await firstResource(request, 'taskSops', (item) => !item.archived);
  const proto = template.resource as Record<string, unknown>;
  const scene = (await listResourceSummaries(request, 'scenes')).find((item) => item.name === proto.scene);
  expect(scene).toBeDefined();
  const draft = await createResource(request, 'taskSops', cloneResourceForCreate(template.resource, {
    displayName: title,
    description: 'durable baseline',
    sourceId,
    legacySubsceneCode: sourceId,
    legacySubsceneDisplayName: title,
    lifecycle: 'LIFECYCLE_DRAFT',
  }));
  return { draft, scene: scene! };
}

async function openDraft(page: Page, sceneName: string, title: string, authenticate = true): Promise<void> {
  if (authenticate) await openAuthenticated(page);
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', {
    name: new RegExp(`^${escapeRegex(sceneName)}\\s+\\d+ 个任务 SOP$`),
  }).click();
  await page.locator('.scene-main .data-table-row.clickable').filter({ hasText: title }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

test('EVA-03 restores an offline TaskSop edit after reload and syncs automatically', async ({ page, request }, testInfo) => {
  const title = `EVA 离线恢复 R${testInfo.retry}`;
  const { draft, scene } = await createDraftFixture(request, title, `eva-offline-r${testInfo.retry}`);
  await openDraft(page, scene.displayName, title);
  const path = resourcePath('taskSops', draft.name);
  let aborted = 0;
  await page.route('**/api/resources/taskSops/**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'PUT' && url.pathname === path) {
      aborted += 1;
      await route.abort('internetdisconnected');
      return;
    }
    await route.continue();
  });

  const description = page.getByLabel('任务 SOP 描述');
  await description.fill('离线期间输入且刷新后仍存在');
  await expect.poll(() => aborted).toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByLabel('任务 SOP 描述')).toHaveValue('离线期间输入且刷新后仍存在');

  await page.unroute('**/api/resources/taskSops/**');
  const savedResponse = page.waitForResponse((response) =>
    response.request().method() === 'PUT' && new URL(response.url()).pathname === path && response.ok());
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await savedResponse;
  await expect.poll(async () => ((await getResource(request, 'taskSops', draft.name)).resource as Record<string, unknown>).description)
    .toBe('离线期间输入且刷新后仍存在');
});

test('EVA-04 retries a committed response loss with the same mutation id', async ({ page, request }, testInfo) => {
  const title = `EVA 幂等重试 R${testInfo.retry}`;
  const { draft, scene } = await createDraftFixture(request, title, `eva-idempotent-r${testInfo.retry}`);
  await openDraft(page, scene.displayName, title);
  const path = resourcePath('taskSops', draft.name);
  const mutations: string[] = [];
  let swallowed = false;
  await page.route('**/api/resources/taskSops/**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'PUT' || url.pathname !== path) {
      await route.continue();
      return;
    }
    const body = route.request().postDataJSON() as { mutationId?: string };
    mutations.push(body.mutationId ?? '');
    if (!swallowed) {
      swallowed = true;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort('failed');
      return;
    }
    await route.continue();
  });

  await page.getByLabel('任务 SOP 描述').fill('服务器已提交但第一次响应丢失');
  await expect.poll(() => mutations.length, { timeout: 8_000 }).toBeGreaterThanOrEqual(2);
  expect(mutations[0]).toBeTruthy();
  expect(mutations[1]).toBe(mutations[0]);
  await expect.poll(async () => ((await getResource(request, 'taskSops', draft.name)).resource as Record<string, unknown>).description)
    .toBe('服务器已提交但第一次响应丢失');
});

test('EVA-09 coordinates two tabs through one TaskSop sync leader', async ({ page, request }, testInfo) => {
  const title = `EVA 多标签页 R${testInfo.retry}`;
  const { draft, scene } = await createDraftFixture(request, title, `eva-tabs-r${testInfo.retry}`);
  const secondPage = await page.context().newPage();
  const path = resourcePath('taskSops', draft.name);
  let writes = 0;
  page.context().on('request', (requestEvent) => {
    if (requestEvent.method() === 'PUT' && new URL(requestEvent.url()).pathname === path) writes += 1;
  });
  try {
    await Promise.all([openAuthenticated(page), openAuthenticated(secondPage)]);
    await openDraft(page, scene.displayName, title, false);
    await openDraft(secondPage, scene.displayName, title, false);
    await secondPage.getByLabel('任务 SOP 描述').fill('第二个标签页的修改');

    await expect(page.getByLabel('任务 SOP 描述')).toHaveValue('第二个标签页的修改');
    await expect.poll(async () => ((await getResource(request, 'taskSops', draft.name)).resource as Record<string, unknown>).description)
      .toBe('第二个标签页的修改');
    expect(writes).toBe(1);
  } finally {
    await secondPage.close();
  }
});

test('EVA-10 and EVA-11 auto-merge disjoint edits and ask only for a same-field conflict', async ({ page, request }, testInfo) => {
  const title = `EVA 并发合并 R${testInfo.retry}`;
  const renamed = `${title} 服务器改名`;
  const { draft, scene } = await createDraftFixture(request, title, `eva-conflict-r${testInfo.retry}`);
  await openDraft(page, scene.displayName, title);

  const remoteBase = await getResource(request, 'taskSops', draft.name);
  const remoteRenamed = await updateResource(request, 'taskSops', remoteBase, {
    ...(remoteBase.resource as Record<string, unknown>),
    displayName: renamed,
  } as JsonValue);
  await page.getByLabel('任务 SOP 描述').fill('本地修改不同字段');
  await expect.poll(async () => {
    const resource = (await getResource(request, 'taskSops', draft.name)).resource as Record<string, unknown>;
    return [resource.displayName, resource.description];
  }).toEqual([renamed, '本地修改不同字段']);
  await expect(page.getByRole('dialog', { name: '检测到其他编辑者的修改' })).toHaveCount(0);

  const secondRemote = await getResource(request, 'taskSops', draft.name);
  await updateResource(request, 'taskSops', secondRemote, {
    ...(secondRemote.resource as Record<string, unknown>),
    description: '服务器修改同一字段',
  } as JsonValue);
  await page.getByLabel('任务 SOP 描述').fill('我的同字段修改');
  const dialog = page.getByRole('dialog', { name: '检测到其他编辑者的修改' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('任务 SOP 描述')).toBeVisible();
  await dialog.getByRole('button', { name: /你的修改/ }).click();
  await dialog.getByRole('button', { name: '应用并保存' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => ((await getResource(request, 'taskSops', draft.name)).resource as Record<string, unknown>).description)
    .toBe('我的同字段修改');
  expect(remoteRenamed.resource).toMatchObject({ displayName: renamed });
});
