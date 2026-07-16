import { readFile } from 'node:fs/promises';
import type { JsonValue } from '@bufbuild/protobuf';
import { expect, test } from '@playwright/test';
import YAML from 'yaml';
import type {
  ConfirmationResult,
  DependencyReviewResult,
  ResourceMutationResult,
  RevisionDetail,
  RevisionSummary,
} from '../../shared/transport/resourceDto';
import {
  apiJson,
  cloneResourceForCreate,
  createResource,
  firstResource,
  getResource,
  installPrintObserver,
  listResourceSummaries,
  listRevisions,
  openAuthenticated,
  resourcePath,
  updateResource,
  waitForPrintedDocument,
} from './helpers/app';

function object(value: JsonValue | undefined, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, JsonValue>;
}

type ExportableTaskFixture = {
  revision: RevisionSummary;
  rootName: string;
  taskDisplayName: string;
  sceneDisplayName: string;
  subsceneCode?: string;
};

async function firstExportableTaskRevision(
  request: Parameters<typeof listResourceSummaries>[0],
): Promise<ExportableTaskFixture> {
  const scenes = await listResourceSummaries(request, 'scenes');
  for (const root of await listResourceSummaries(request, 'taskSops')) {
    if (!root.lifecycle?.endsWith('CONFIRMED')) continue;
    const revision = (await listRevisions(request, 'taskSops', root.name)).find((item) => item.exportEligible);
    if (!revision) continue;
    const detail = await apiJson<RevisionDetail>(request, 'GET', `/api/revisions/${encodeURIComponent(revision.name)}`);
    const snapshot = object(object(detail.resource, 'TaskSop revision').snapshot, 'TaskSop snapshot');
    const displayName = typeof snapshot.displayName === 'string' ? snapshot.displayName : root.displayName;
    const legacySceneName = typeof snapshot.legacySceneDisplayName === 'string' ? snapshot.legacySceneDisplayName : undefined;
    const sceneDisplayName = scenes.find((scene) => scene.name === root.sceneName)?.displayName || legacySceneName || '';
    const subsceneCode = typeof snapshot.legacySubsceneCode === 'string' ? snapshot.legacySubsceneCode : undefined;
    return { revision, rootName: root.name, taskDisplayName: displayName, sceneDisplayName, subsceneCode };
  }
  throw new Error('Expected an exportable TaskSop revision fixture');
}

test('new Requirement selects operation vocabularies by default and supports searched bulk selection', async ({ page }) => {
  await openAuthenticated(page);
  await page.getByRole('button', { name: /^客户需求/ }).click();
  const createResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/resources/requirements' &&
    response.request().method() === 'POST');
  await page.getByRole('button', { name: '新建需求' }).click();
  expect((await createResponse).status()).toBe(201);
  await expect(page.getByRole('heading', { name: '新的客户需求' })).toBeVisible();

  for (const title of [
    '采集操作要求',
    '不完美但可接受的采集操作',
    '采集禁止操作',
    '标注操作要求',
    '标注禁止操作',
  ]) {
    const group = page.getByRole('group', { name: title, exact: true });
    const checkboxes = group.locator('input[type="checkbox"]');
    const count = await checkboxes.count();
    expect(count, `${title} should have configured options`).toBeGreaterThan(0);
    await expect(group.locator('input[type="checkbox"]:not(:checked)')).toHaveCount(0);
  }

  const forbidden = page.getByRole('group', { name: '采集禁止操作', exact: true });
  await forbidden.getByRole('searchbox', { name: '搜索采集禁止操作' }).fill('画面');
  const filtered = forbidden.locator('.operation-requirement-option');
  const filteredCount = await filtered.count();
  expect(filteredCount).toBeGreaterThan(0);

  const clearResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.startsWith('/api/resources/requirements/') &&
    response.request().method() === 'PUT');
  await forbidden.getByRole('button', { name: '取消结果' }).click();
  expect((await clearResponse).ok()).toBe(true);
  await expect(filtered.locator('input:checked')).toHaveCount(0);

  const selectResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.startsWith('/api/resources/requirements/') &&
    response.request().method() === 'PUT');
  await forbidden.getByRole('button', { name: '全选结果' }).click();
  expect((await selectResponse).ok()).toBe(true);
  await expect(filtered.locator('input:checked')).toHaveCount(filteredCount);
});

test('Requirement create → ETag update → review → confirm → export → next draft → restore remains stable', async ({ page, request }, testInfo) => {
  await installPrintObserver(page);
  const title = `E2E 关联需求 R${testInfo.retry}`;
  const [template, customer, robot, task] = await Promise.all([
    firstResource(request, 'requirements', (item) => !item.archived),
    firstResource(request, 'customers', (item) => !item.archived),
    firstResource(request, 'robotModels', (item) => !item.archived),
    firstExportableTaskRevision(request),
  ]);
  expect(robot.currentRevision).toBeTruthy();

  const createBody = object(cloneResourceForCreate(template.resource, {
    displayName: title,
    description: '资源级 E2E 客户需求',
    sourceId: `e2e-requirement-r${testInfo.retry}`,
    lifecycle: 'LIFECYCLE_DRAFT',
    attachments: [],
  }), 'Requirement');
  const templateSpec = object(object(template.resource, 'Requirement template').spec, 'Requirement spec');
  createBody.spec = {
    ...structuredClone(templateSpec),
    customer: customer.name,
    robotModelRevision: robot.currentRevision!,
    projectDisplayName: 'E2E 项目',
    businessGoal: '初始业务目标',
    productionItems: [{
      id: 'item-e2e',
      displayName: '基线生产项',
      description: '用于跨页导航',
      taskSopRevision: task.revision.name,
      target: { collectionCount: '2' },
      legacySceneName: task.sceneDisplayName,
      ...(task.subsceneCode ? { legacySubsceneCode: task.subsceneCode } : {}),
      legacySubsceneName: task.taskDisplayName,
      legacyVersionLabel: task.revision.versionLabel,
      legacyLifecycle: 'LIFECYCLE_CONFIRMED',
    }],
    aggregateTarget: { collectionCount: '2' },
    requestedSceneNames: ['家庭场景'],
  };

  let draft = await createResource(request, 'requirements', createBody);
  expect(draft).toMatchObject({
    name: `requirements/e2e-requirement-r${testInfo.retry}`,
    lifecycle: 'DRAFT',
    resource: { displayName: title, candidateVersionLabel: '0.0.1' },
  });
  const draftCreatedAt = object(draft.resource, 'Requirement').candidateCreateTime;
  expect(draftCreatedAt).toEqual(expect.any(String));

  const updatedResource = structuredClone(draft.resource);
  object(object(updatedResource, 'Requirement').spec, 'Requirement spec').businessGoal = '更新后的业务目标';
  draft = await updateResource(request, 'requirements', draft, updatedResource);
  expect(object(object(draft.resource, 'Requirement').spec, 'Requirement spec').businessGoal).toBe('更新后的业务目标');
  expect(object(draft.resource, 'Requirement').candidateCreateTime).toBe(draftCreatedAt);

  const taskRoot = await getResource(request, 'taskSops', task.rootName);
  const newerTaskDraft = await apiJson<ResourceMutationResult>(
    request,
    'POST',
    `${resourcePath('taskSops', task.rootName)}/drafts`,
    { expectedEtag: taskRoot.etag },
  );
  expect(newerTaskDraft.resource.candidateVersionLabel).not.toBe(task.revision.versionLabel);

  await openAuthenticated(page);
  await page.getByPlaceholder('搜索需求名称、客户、项目').fill(title);
  await page.getByRole('button', { name: new RegExp(title) }).first().click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.locator('.version-time-meta')).toContainText('创建时间');
  await expect(page.locator('.version-time-meta')).toContainText('更新时间');
  await expect(page.getByRole('button', { name: '加载更多客户' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '加载更多机器人' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '加载更多全局字段' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'YAML 预览' })).toHaveCount(0);
  await page.getByRole('button', { name: '导出' }).click();
  await expect(page.getByRole('button', { name: '导出 YAML' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '导出 PDF' })).toBeEnabled();
  await page.getByRole('button', { name: '导出 PDF' }).click();
  await expect(page.frameLocator('iframe[title$=".pdf"]').locator('body')).toContainText(title);

  const rootPath = resourcePath('requirements', draft.name);
  const review = await apiJson<DependencyReviewResult>(request, 'POST', `${rootPath}/review-proposal`, {
    expectedEtag: draft.etag,
  });
  expect(review).toMatchObject({ rootName: draft.name, rootEtag: draft.etag });

  const blockedConfirmation = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `${rootPath}/confirmations` && response.request().method() === 'POST');
  const acknowledgement = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `${rootPath}/review-acknowledgements` && response.request().method() === 'POST');
  const dialogPromise = page.waitForEvent('dialog');
  const firstConfirmClick = page.getByRole('button', { name: '确认版本' }).click();
  const dialog = await dialogPromise;
  expect(dialog.message()).toContain('确认冻结当前直接依赖');
  await dialog.accept();
  await firstConfirmClick;
  expect((await blockedConfirmation).status()).toBe(409);
  expect((await acknowledgement).ok()).toBe(true);
  await expect(page.getByText('依赖审阅已确认，请再次点击确认版本')).toBeVisible();
  await expect(page.getByText('客户需求版本已确认')).toHaveCount(0);
  await expect(page.getByRole('paragraph').filter({ hasText: 'v0.0.1 · 草稿' })).toBeVisible();

  const confirmedResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `${rootPath}/confirmations` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '确认版本' }).click();
  const confirmationResponse = await confirmedResponse;
  expect(confirmationResponse.ok()).toBe(true);
  const confirmed = await confirmationResponse.json() as ConfirmationResult;
  expect(confirmed).toMatchObject({
    resource: { name: draft.name, lifecycle: 'CONFIRMED' },
    revision: { versionLabel: '0.0.1', exportEligible: true },
    idempotent: false,
  });
  await expect(page.getByText('客户需求版本已确认')).toBeVisible();
  await expect(page.getByRole('paragraph').filter({ hasText: 'v0.0.1 · 已确认' })).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑为草稿' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/requirements/${confirmed.revision.uid}$`));
  await page.goto(`/requirements/${confirmed.revision.uid}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: /^客户需求/ }).click();
  await page.getByPlaceholder('搜索需求名称、客户、项目').fill(title);
  await page.getByRole('button', { name: new RegExp(title) }).first().click();
  await expect(page.getByText('当前版本已确认')).toBeVisible();

  await page.getByRole('button', { name: '导出' }).click();
  const yamlDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 YAML' }).click();
  const yamlDownload = await yamlDownloadPromise;
  expect(yamlDownload.suggestedFilename()).toMatch(/\.yaml$/);
  const yamlPath = await yamlDownload.path();
  expect(yamlPath).toBeTruthy();
  const exportedDocument = YAML.parse(await readFile(yamlPath!, 'utf8'));
  expect(exportedDocument).toEqual(expect.objectContaining({
    format: 'coscene.sop.export', schema_version: '2.0.1', requirement: expect.objectContaining({ basic_info: expect.any(Object) }),
  }));
  expect(exportedDocument.requirement.production_requirement_items[0].target_collection_count).toBe(2);
  expect(exportedDocument.requirement.task_sop_details).toHaveLength(1);
  expect(exportedDocument.requirement.robot).toEqual(expect.objectContaining({ model: expect.any(String) }));

  await page.getByRole('button', { name: '导出' }).click();
  await page.getByRole('button', { name: '导出 PDF' }).click();
  const pdfFrame = page.frameLocator('iframe[title$=".pdf"]');
  await expect(pdfFrame.locator('body')).toContainText(title);
  await expect(pdfFrame.locator('body')).toContainText('0.0.1');
  expect((await waitForPrintedDocument(page, title)).text).toContain('0.0.1');

  await page.getByRole('button', { name: '查看' }).last().click();
  await expect(page.getByRole('button', { name: '返回需求页' })).toBeVisible();
  await expect(page.getByTestId('task-sop-version-trigger')).toContainText(`v${task.revision.versionLabel}`);
  await page.getByRole('button', { name: '返回需求页' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  const draftPath = `${resourcePath('requirements', draft.name)}/drafts`;
  const createDraftResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === draftPath && response.request().method() === 'POST');
  await page.getByRole('button', { name: '编辑为草稿' }).click();
  const createdDraftResponse = await createDraftResponse;
  expect(createdDraftResponse.ok()).toBeTruthy();
  const createdDraft = await createdDraftResponse.json() as ResourceMutationResult;
  expect(createdDraft.resource.resource).toMatchObject({ candidateVersionLabel: '0.0.2' });
  await expect(page.getByText('已创建草稿版本')).toBeVisible();
  await expect(page.getByLabel('版本')).toHaveValue('0.0.2');

  await page.getByLabel('版本').selectOption('0.0.1');
  await expect(page.getByRole('button', { name: '进入当前草稿' })).toBeVisible();
  await page.getByRole('button', { name: '进入当前草稿' }).click();
  await expect(page.getByLabel('版本')).toHaveValue('0.0.2');

  const deleteDraftResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === draftPath && response.request().method() === 'DELETE');
  await page.getByRole('button', { name: '删除草稿' }).click();
  expect((await deleteDraftResponse).ok()).toBeTruthy();
  await expect(page.getByText('草稿版本已删除')).toBeVisible();
  await expect(page.getByLabel('版本')).toHaveValue('0.0.1');

  await page.reload();
  await page.getByRole('button', { name: /^客户需求/ }).click();
  await page.getByPlaceholder('搜索需求名称、客户、项目').fill(title);
  await page.getByRole('button', { name: new RegExp(title) }).first().click();
  await expect(page.getByLabel('版本').locator('option')).toHaveCount(1);
  await expect(page.getByText('当前版本已确认')).toBeVisible();
  await expect(getResource(request, 'requirements', draft.name)).resolves.toMatchObject({ lifecycle: 'CONFIRMED' });
  await expect(listRevisions(request, 'requirements', draft.name)).resolves.toEqual([
    expect.objectContaining({ name: confirmed.revision.name, versionLabel: '0.0.1', exportEligible: true }),
  ]);
});
