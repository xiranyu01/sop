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
    // The ROOT's lifecycle is not the fixture requirement: a TaskSop with an editable draft
    // candidate reports DRAFT while still owning confirmed, export-eligible revisions — which is
    // exactly the shape the seeded 洗漱台整理 has. An export-eligible revision is confirmed by
    // definition, so that alone is the predicate.
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
  const invalidTitleRequests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.postData()?.includes('"displayName":""')) {
      invalidTitleRequests.push(request.url());
    }
  });
  await openAuthenticated(page);
  await page.getByRole('button', { name: /^客户需求/ }).click();
  const createResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/resources/requirements' &&
    response.request().method() === 'POST');
  await page.getByRole('button', { name: '新建需求' }).click();
  expect((await createResponse).status()).toBe(201);
  await expect(page.getByRole('heading', { name: '新的客户需求' })).toBeVisible();

  await expect(page.getByLabel('交付形式')).toHaveValue('');
  await expect(page.getByLabel('是否需要标注')).toHaveValue('');
  await expect(page.getByLabel('客户抽检策略')).toHaveValue('');

  const requirementName = page.getByLabel('需求名称');
  await requirementName.fill('');
  await page.getByRole('heading', { name: '基础信息' }).click();
  await expect(requirementName).toHaveValue('新的客户需求');
  expect(invalidTitleRequests).toEqual([]);

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
  expect(invalidTitleRequests).toEqual([]);
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
      // Confirm rejects an item without a production flow, so a fixture that reaches 确认版本
      // has to carry one. Divergent per-item robots and flows are covered by the next test.
      productionFlow: 'PRODUCTION_FLOW_COLLECT',
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
  await expect(page.getByRole('columnheader', { name: 'SOP 版本' })).toHaveCount(0);
  await expect(page.locator('.task-sop-reference-cell')).toContainText(task.taskDisplayName);
  await expect(page.locator('.task-sop-reference-cell')).toContainText(`v${task.revision.versionLabel}`);
  await expect(page.locator('.task-sop-reference-cell')).toContainText('已确认');
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
  await waitForPrintedDocument(page, title);

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
    // 2.1.0 since the export carries per-item robot and production flow; tests/unit/yaml-export
    // asserts the same version.
    format: 'coscene.sop.export', schema_version: '2.1.0', requirement: expect.objectContaining({ basic_info: expect.any(Object) }),
  }));
  expect(exportedDocument.requirement.production_requirement_items[0].target_collection_count).toBe(2);
  expect(exportedDocument.requirement.task_sop_details).toHaveLength(1);
  expect(exportedDocument.requirement.robot).toEqual(expect.objectContaining({ model: expect.any(String) }));

  await page.getByRole('button', { name: '导出' }).click();
  await page.getByRole('button', { name: '导出 PDF' }).click();
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

  let deleteDraftRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === draftPath && request.method() === 'DELETE') deleteDraftRequests += 1;
  });
  const cancelDeleteDialog = page.waitForEvent('dialog');
  const cancelDeleteClick = page.getByRole('button', { name: '删除草稿' }).click();
  const cancelDelete = await cancelDeleteDialog;
  expect(cancelDelete.message()).toContain('确定删除客户需求草稿 v0.0.2');
  await cancelDelete.dismiss();
  await cancelDeleteClick;
  expect(deleteDraftRequests).toBe(0);
  await expect(page.getByLabel('版本')).toHaveValue('0.0.2');

  const deleteDraftResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === draftPath && response.request().method() === 'DELETE');
  const confirmDeleteDialog = page.waitForEvent('dialog');
  const confirmDeleteClick = page.getByRole('button', { name: '删除草稿' }).click();
  await (await confirmDeleteDialog).accept();
  await confirmDeleteClick;
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

test('collection tasks take divergent robots and their own production flow', async ({ page, request }, testInfo) => {
  const title = `E2E 分歧机型需求 R${testInfo.retry}`;
  const [template, customer, task] = await Promise.all([
    firstResource(request, 'requirements', (item) => !item.archived),
    firstResource(request, 'customers', (item) => !item.archived),
    firstExportableTaskRevision(request),
  ]);
  const robots = (await listResourceSummaries(request, 'robotModels'))
    .filter((item) => !item.archived && item.currentRevision);
  expect(robots.length, 'divergent per-item robots need two RobotModel fixtures').toBeGreaterThanOrEqual(2);

  const createBody = object(cloneResourceForCreate(template.resource, {
    displayName: title,
    description: '每个采集任务各自的机器人型号和生产流程',
    sourceId: `e2e-divergent-robots-r${testInfo.retry}`,
    lifecycle: 'LIFECYCLE_DRAFT',
    attachments: [],
  }), 'Requirement');
  const templateSpec = object(object(template.resource, 'Requirement template').spec, 'Requirement spec');
  // Neither item carries a robot or a flow: the default fills the robot in, and the flow is the
  // gap the banner has to report.
  const productionItem = (id: string, displayName: string) => ({
    id,
    displayName,
    taskSopRevision: task.revision.name,
    target: { collectionCount: '1' },
    legacySceneName: task.sceneDisplayName,
    ...(task.subsceneCode ? { legacySubsceneCode: task.subsceneCode } : {}),
    legacySubsceneName: task.taskDisplayName,
    legacyVersionLabel: task.revision.versionLabel,
    legacyLifecycle: 'LIFECYCLE_CONFIRMED',
  });
  createBody.spec = {
    ...structuredClone(templateSpec),
    customer: customer.name,
    robotModelRevision: robots[0]!.currentRevision!,
    projectDisplayName: 'E2E 项目',
    productionItems: [productionItem('item-a', '采集任务甲'), productionItem('item-b', '采集任务乙')],
    aggregateTarget: { collectionCount: '2' },
    requestedSceneNames: ['家庭场景'],
  };
  const draft = await createResource(request, 'requirements', createBody);

  const savePut = () => page.waitForResponse((response) =>
    new URL(response.url()).pathname === resourcePath('requirements', draft.name) &&
    response.request().method() === 'PUT');
  const productionItems = async () => {
    const detail = await getResource(request, 'requirements', draft.name);
    const spec = object(object(detail.resource, 'Requirement').spec, 'Requirement spec');
    return (spec.productionItems as JsonValue[]).map((item) => object(item, 'ProductionItem'));
  };

  await openAuthenticated(page);
  await page.goto(`/requirements/${draft.uid}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByText('2 / 2 采集任务缺少生产流程，确认前需补齐')).toBeVisible();

  // Batch action reaches the ticked rows only, so tick every row first.
  await page.getByRole('button', { name: '全选采集任务', exact: true }).click();
  const batchRobot = page.getByLabel('批量机器人型号');
  await batchRobot.selectOption({ index: 1 });
  const primaryRobotId = await batchRobot.inputValue();
  const batched = savePut();
  await page.getByRole('button', { name: '批量设置机器人型号（2）' }).click();
  expect((await batched).ok()).toBe(true);
  await expect.poll(async () => (await productionItems()).map((item) => item.robotModelRevision))
    .toEqual([expect.any(String), expect.any(String)]);
  const batchedRevisions = (await productionItems()).map((item) => item.robotModelRevision);
  expect(batchedRevisions[0]).toBe(batchedRevisions[1]);

  // Divergence: the second collection task moves to the other robot on its own.
  const secondRobot = page.getByLabel('采集任务乙 机器人型号');
  await secondRobot.selectOption({ index: 2 });
  const secondRobotId = await secondRobot.inputValue();
  expect(secondRobotId).not.toBe(primaryRobotId);
  const secondRobotLabel = (await secondRobot.locator('option:checked').textContent())?.trim() || '';
  await expect(page.getByLabel('采集任务甲 机器人型号')).toHaveValue(primaryRobotId);
  await expect.poll(async () => {
    const items = await productionItems();
    return items[0]!.robotModelRevision !== items[1]!.robotModelRevision;
  }).toBe(true);

  // One flow set, one still missing — the banner counts down rather than disappearing.
  await page.getByLabel('采集任务甲 流程配置').selectOption('collect');
  await expect(page.getByText('1 / 2 采集任务缺少生产流程，确认前需补齐')).toBeVisible();
  await expect.poll(async () => (await productionItems())[0]!.productionFlow).toBe('PRODUCTION_FLOW_COLLECT');
  expect((await productionItems())[1]!.productionFlow).toBeUndefined();

  // Search reaches a robot that only one collection task uses — the requirement-level default is
  // the other one.
  await page.getByRole('button', { name: /^客户需求/ }).click();
  await page.getByPlaceholder('搜索需求名称、客户、项目').fill(secondRobotLabel);
  await expect(page.getByRole('button', { name: new RegExp(title) }).first()).toBeVisible();

  // Readonly rows render plain text, and an item that never got a flow reads 未配置 — distinct
  // from the 请选择 an editable row shows.
  await page.goto(`/requirements/${draft.uid}`);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '归档', exact: true }).click();
  await expect(page.getByRole('heading', { name: '归档库' })).toBeVisible();
  await page.getByText(title, { exact: true }).click();
  await expect(page.getByText('归档内容只读。')).toBeVisible();
  await expect(page.getByLabel('采集任务甲 流程配置')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '批量设置机器人型号（0）' })).toHaveCount(0);
  await expect(page.getByText('未配置', { exact: true })).toHaveCount(1);
  await expect(page.locator('.subscene-group span[title="采集"]')).toHaveCount(1);
});
