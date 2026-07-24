import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import YAML from 'yaml';
import type {
  ConfirmationResult,
  DependencyReviewResult,
  ResourceMutationResult,
  ResourceSummary,
  RevisionSummary,
} from '../../shared/transport/resourceDto';
import {
  apiJson,
  authHeaders,
  cloneResourceForCreate,
  createResource,
  firstResource,
  getResource,
  installPrintObserver,
  listResourceSummaries,
  listRevisions,
  openAuthenticated,
  resourcePath,
  waitForPrintedDocument,
} from './helpers/app';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function openTaskSopFromTable(page: Page, title: string) {
  await page.locator('.scene-main .data-table-row.clickable').filter({ hasText: title }).click();
}

test('Scene library keeps the directory compact and highlights the selected Scene', async ({ page }) => {
  await openAuthenticated(page);
  await page.getByRole('button', { name: /^场景库/ }).click();

  const selectedScene = page.locator('.scene-row[aria-current="page"]');
  await expect(selectedScene).toBeVisible();
  await expect(selectedScene.locator('.scene-row-count')).toHaveText(/\d+/);
  await expect(page.locator('.scene-summary-meta')).toContainText(/最近更新/);
  await expect(page.locator('.directory-children, .subscene-row')).toHaveCount(0);
  await expect(page.locator('.scene-main .table-panel').getByRole('columnheader', { name: '物料' })).toHaveCount(0);
  await expect(page.locator('.scene-summary .info-grid')).toHaveCount(0);
});

test('creates a Scene from the Scene dialog', async ({ page }, testInfo) => {
  const sceneName = `E2E 新场景 R${testInfo.retry}`;
  await openAuthenticated(page);
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', { name: '新建场景' }).click();

  const dialog = page.getByRole('dialog', { name: '新建场景' });
  const nameInput = dialog.getByLabel('场景名称');
  await expect(nameInput).toBeFocused();
  await expect(nameInput).toHaveJSProperty('selectionStart', 0);
  await expect(nameInput).toHaveJSProperty('selectionEnd', await nameInput.inputValue().then((value) => value.length));
  await nameInput.fill(sceneName);
  const createResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/resources/scenes' &&
    response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '保存场景' }).click();
  expect((await createResponse).status()).toBe(201);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: sceneName })).toBeVisible();
});

test('creates a new TaskSop from the selected Scene', async ({ page, request }) => {
  const template = await firstResource(request, 'taskSops', (item) => !item.archived);
  const templateProto = template.resource;
  if (!templateProto || typeof templateProto !== 'object' || Array.isArray(templateProto) || typeof templateProto.scene !== 'string') {
    throw new TypeError('TaskSop template must identify its Scene');
  }
  const scene = (await listResourceSummaries(request, 'scenes')).find((item) => item.name === templateProto.scene);
  expect(scene, `Expected Scene ${templateProto.scene}`).toBeDefined();

  await openAuthenticated(page);
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', {
    name: new RegExp(`^${escapeRegex(scene!.displayName)}\\s+\\d+ 个任务 SOP$`),
  }).click();

  const createdResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/resources/taskSops' &&
    response.request().method() === 'POST');
  await page.getByRole('button', { name: '新建任务 SOP' }).click();
  expect((await createdResponse).status()).toBe(201);
  await expect(page.getByRole('heading', { name: '新的任务 SOP' })).toBeVisible();
  await expect(page.getByTestId('task-sop-version-trigger')).toContainText('v0.0.1 · 草稿');
});

test('TaskSop draft → review → confirm → export → next draft → restore lifecycle remains stable', async ({ page, request }, testInfo) => {
  await installPrintObserver(page);
  const title = `E2E 生命周期 SOP R${testInfo.retry}`;
  const template = await firstResource(request, 'taskSops', (item) => !item.archived);
  const templateProto = template.resource;
  if (!templateProto || typeof templateProto !== 'object' || Array.isArray(templateProto) || typeof templateProto.scene !== 'string') {
    throw new TypeError('TaskSop template must identify its Scene');
  }
  const scene = (await listResourceSummaries(request, 'scenes')).find((item) => item.name === templateProto.scene);
  expect(scene, `Expected Scene ${templateProto.scene}`).toBeDefined();
  const draft = await createResource(request, 'taskSops', cloneResourceForCreate(template.resource, {
    displayName: title,
    description: '资源级 E2E 生命周期',
    sourceId: `e2e-task-r${testInfo.retry}`,
    legacySubsceneCode: `E2E-R${testInfo.retry}`,
    legacySubsceneDisplayName: title,
    lifecycle: 'LIFECYCLE_DRAFT',
  }));
  expect(draft).toMatchObject({
    name: `taskSops/e2e-task-r${testInfo.retry}`,
    lifecycle: 'DRAFT',
    resource: { displayName: title, candidateVersionLabel: '0.0.1' },
  });

  await openAuthenticated(page);
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', {
    name: new RegExp(`^${escapeRegex(scene!.displayName)}\\s+\\d+ 个任务 SOP$`),
  }).click();
  await openTaskSopFromTable(page, title);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.locator('.version-time-meta')).toContainText('创建时间');
  await expect(page.locator('.version-time-meta')).toContainText('更新时间');
  await expect(page.getByRole('button', { name: '加载更多全局字段' })).toHaveCount(0);

  await page.getByRole('button', { name: '导出' }).click();
  await expect(page.getByRole('button', { name: '导出 PDF' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '导出 YAML' })).toBeDisabled();
  await page.getByRole('button', { name: '导出 PDF' }).click();
  await waitForPrintedDocument(page, title);

  const rootPath = resourcePath('taskSops', draft.name);
  const review = await apiJson<DependencyReviewResult>(request, 'POST', `${rootPath}/review-proposal`, {
    expectedEtag: draft.etag,
  });
  expect(review).toMatchObject({ rootName: draft.name, rootEtag: draft.etag });

  const blockedConfirmation = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `${rootPath}/confirmations` &&
    response.request().method() === 'POST' && response.status() === 409);
  const confirmedResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `${rootPath}/confirmations` &&
    response.request().method() === 'POST' && response.ok());
  const acknowledgement = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `${rootPath}/review-acknowledgements` && response.request().method() === 'POST');
  const dialogPromise = page.waitForEvent('dialog');
  const firstConfirmClick = page.getByRole('button', { name: '确认任务 SOP' }).click();
  const dialog = await dialogPromise;
  expect(dialog.message()).toContain('确认冻结当前直接依赖');
  await dialog.accept();
  await firstConfirmClick;
  expect((await blockedConfirmation).status()).toBe(409);
  expect((await acknowledgement).ok()).toBe(true);
  const confirmationResponse = await confirmedResponse;
  expect(confirmationResponse.ok()).toBe(true);
  const confirmed = await confirmationResponse.json() as ConfirmationResult;
  expect(confirmed).toMatchObject({
    resource: { name: draft.name, lifecycle: 'CONFIRMED' },
    revision: { versionLabel: '0.0.1', exportEligible: true },
    idempotent: false,
  });
  expect(confirmed.exportPath).toBe(`/api/revisions/${encodeURIComponent(confirmed.revision.name)}/export.yaml`);
  await expect(page.getByText('任务 SOP 版本已确认')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/task-sops/${confirmed.revision.uid}$`));
  await page.goto(`/task-sops/${confirmed.revision.uid}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', {
    name: new RegExp(`^${escapeRegex(scene!.displayName)}\\s+\\d+ 个任务 SOP$`),
  }).click();
  await openTaskSopFromTable(page, title);
  await expect(page.getByText('当前任务 SOP 已确认')).toBeVisible();

  await page.getByRole('button', { name: '导出' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 YAML' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.yaml$/);
  const path = await download.path();
  expect(path).toBeTruthy();
  expect(YAML.parse(await readFile(path!, 'utf8'))).toEqual(expect.objectContaining({
    format: 'coscene.sop.export', schema_version: '2.0.1', task_sop: expect.objectContaining({ status: '已确认' }),
  }));

  await page.getByRole('button', { name: '导出' }).click();
  await page.getByRole('button', { name: '导出 PDF' }).click();
  expect((await waitForPrintedDocument(page, title)).text).toContain('0.0.1');

  const draftPath = `${resourcePath('taskSops', draft.name)}/drafts`;
  const createDraftResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === draftPath && response.request().method() === 'POST');
  await page.getByRole('button', { name: '编辑为草稿' }).click();
  const createdDraftResponse = await createDraftResponse;
  expect(createdDraftResponse.ok()).toBeTruthy();
  const createdDraft = await createdDraftResponse.json() as ResourceMutationResult;
  expect(createdDraft.resource.resource).toMatchObject({ candidateVersionLabel: '0.0.2' });
  await expect(page.getByText('已创建草稿版本')).toBeVisible();
  await expect(page.getByTestId('task-sop-version-trigger')).toContainText('v0.0.2');

  await page.getByTestId('task-sop-version-trigger').click();
  await expect(page.getByRole('menu', { name: '任务 SOP 版本' })).toBeVisible();
  await page.getByTestId('task-sop-version-0.0.1').click();
  await expect(page.getByRole('button', { name: '进入当前草稿' })).toBeVisible();
  await page.getByRole('button', { name: '进入当前草稿' }).click();
  await expect(page.getByTestId('task-sop-version-trigger')).toContainText('v0.0.2');

  let deleteDraftRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === draftPath && request.method() === 'DELETE') deleteDraftRequests += 1;
  });
  const cancelDeleteDialog = page.waitForEvent('dialog');
  const cancelDeleteClick = page.getByRole('button', { name: '删除草稿' }).click();
  const cancelDelete = await cancelDeleteDialog;
  expect(cancelDelete.message()).toContain('确定删除任务 SOP 草稿 v0.0.2');
  await cancelDelete.dismiss();
  await cancelDeleteClick;
  expect(deleteDraftRequests).toBe(0);
  await expect(page.getByTestId('task-sop-version-trigger')).toContainText('v0.0.2');

  const deleteDraftResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === draftPath && response.request().method() === 'DELETE');
  const confirmDeleteDialog = page.waitForEvent('dialog');
  const confirmDeleteClick = page.getByRole('button', { name: '删除草稿' }).click();
  await (await confirmDeleteDialog).accept();
  await confirmDeleteClick;
  expect((await deleteDraftResponse).ok()).toBeTruthy();
  await expect(page.getByText('草稿版本已删除')).toBeVisible();
  await expect(page.getByTestId('task-sop-version-trigger')).toContainText('v0.0.1');
  await expect(page.getByText('当前任务 SOP 已确认')).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', {
    name: new RegExp(`^${escapeRegex(scene!.displayName)}\\s+\\d+ 个任务 SOP$`),
  }).click();
  await openTaskSopFromTable(page, title);
  await page.getByTestId('task-sop-version-trigger').click();
  await expect(page.getByRole('menuitemradio')).toHaveCount(1);
  await expect(page.getByText('当前任务 SOP 已确认')).toBeVisible();
  await expect(getResource(request, 'taskSops', draft.name)).resolves.toMatchObject({ lifecycle: 'CONFIRMED' });
  await expect(listRevisions(request, 'taskSops', draft.name)).resolves.toEqual([
    expect.objectContaining({ name: confirmed.revision.name, versionLabel: '0.0.1', exportEligible: true }),
  ]);
});

test('robot initial state saves successfully and does not offer the empty placeholder', async ({ page, request }, testInfo) => {
  const title = `E2E 机器人初始态 R${testInfo.retry}`;
  const randomFieldLabel = `机械臂位置 R${testInfo.retry}`;
  const randomFieldValue = `robot_arm_position_r${testInfo.retry}`;
  await createResource(request, 'globalFields', {
    sourceId: `e2e-robot-random-field-r${testInfo.retry}`,
    group: 'GLOBAL_FIELD_GROUP_ROBOT_RANDOM_FIELD',
    label: randomFieldLabel,
    value: randomFieldValue,
    status: 'GLOBAL_FIELD_STATUS_ACTIVE',
    description: '机器人随机性字段回归测试',
  });
  const template = await firstResource(request, 'taskSops', (item) => !item.archived);
  const templateProto = template.resource;
  if (!templateProto || typeof templateProto !== 'object' || Array.isArray(templateProto) || typeof templateProto.scene !== 'string') {
    throw new TypeError('TaskSop template must identify its Scene');
  }
  const scene = (await listResourceSummaries(request, 'scenes')).find((item) => item.name === templateProto.scene);
  expect(scene, `Expected Scene ${templateProto.scene}`).toBeDefined();
  const materialSummaries = (await listResourceSummaries(request, 'materials')).slice(0, 2);
  expect(materialSummaries).toHaveLength(2);
  const draftResource = cloneResourceForCreate(template.resource, {
    displayName: title,
    description: '机器人初始态保存回归测试',
    sourceId: `e2e-robot-initial-state-r${testInfo.retry}`,
    legacySubsceneCode: `E2E-ROBOT-INITIAL-R${testInfo.retry}`,
    legacySubsceneDisplayName: title,
    lifecycle: 'LIFECYCLE_DRAFT',
  });
  if (!draftResource || typeof draftResource !== 'object' || Array.isArray(draftResource) ||
      !draftResource.spec || typeof draftResource.spec !== 'object' || Array.isArray(draftResource.spec)) {
    throw new TypeError('TaskSop draft fixture must include a spec');
  }
  draftResource.spec.objects = materialSummaries.map((material, index) => ({
    id: `e2e-material-${index + 1}`,
    displayName: material.displayName,
    material: material.name,
    quantity: { fixedValue: 1, unit: '件' },
  }));
  draftResource.spec.objectStates = {
    initial: [{
      objectId: 'e2e-material-1',
      allowedLocations: [{ displayName: '初始位置' }],
    }],
    target: [],
    duringOperation: [],
  };
  const draft = await createResource(request, 'taskSops', draftResource);

  await openAuthenticated(page);
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', {
    name: new RegExp(`^${escapeRegex(scene!.displayName)}\\s+\\d+ 个任务 SOP$`),
  }).click();
  await openTaskSopFromTable(page, title);

  const select = page.getByRole('combobox', { name: '机器人初始态', exact: true });
  await expect(select.locator('option[value=""]')).toHaveAttribute('hidden', '');
  const updateResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === resourcePath('taskSops', draft.name) &&
    response.request().method() === 'PUT');
  await select.selectOption({ label: '机器人处于安全初始位' });
  expect((await updateResponse).ok()).toBeTruthy();
  await expect(select).toHaveValue('机器人处于安全初始位');
  await expect(page.locator('.save-state-stack')).toBeHidden();

  const initialStateSection = page.locator('[data-state-section="initial"]');
  if (await initialStateSection.locator('[data-state-kind="initial"]').count() === 0) {
    const addInitialStateResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === resourcePath('taskSops', draft.name) &&
      response.request().method() === 'PUT');
    await initialStateSection.getByRole('button', { name: '添加状态' }).click();
    expect((await addInitialStateResponse).ok()).toBeTruthy();
  }
  const initialStateCard = initialStateSection.locator('[data-state-kind="initial"][data-state-index="0"]');
  if (await initialStateCard.locator('.state-card-detail').count() === 0) {
    await initialStateCard.getByRole('button', { name: '展开编辑' }).click();
  }
  await expect(initialStateCard.locator('.state-card-detail')).toBeVisible();
  await initialStateCard.getByRole('button', { name: '收起字段' }).click();
  await expect(initialStateCard.locator('.state-card-detail')).toBeHidden();
  await expect(initialStateCard.getByRole('button', { name: '展开编辑' })).toBeVisible();

  await expect(initialStateSection.locator('.embedded-table-header')).toHaveCSS('position', 'sticky');
  await expect(initialStateSection.locator('.embedded-table-header')).toHaveCSS('top', '8px');
  await initialStateCard.getByRole('button', { name: '展开编辑' }).click();
  const addedStateCard = initialStateCard;
  const materialSelect = addedStateCard.getByRole('combobox', { name: '物料' });
  const materialChoices = (await materialSelect.locator('option').allTextContents()).filter((item) => item !== '选择物料');
  expect(materialChoices.length).toBeGreaterThan(1);
  const selectedMaterial = await materialSelect.inputValue();
  const replacementMaterial = materialChoices.find((item) => item !== selectedMaterial)!;
  const oldMaterialInstruction = `旧物料说明 R${testInfo.retry}`;
  const instructionButton = addedStateCard.getByRole('button', { name: '编辑采集员说明' });
  await expect(instructionButton).toHaveClass(/placeholder-value/);
  await instructionButton.click();
  const instructionDialog = page.getByRole('dialog', { name: '采集员说明' });
  await instructionDialog.locator('textarea').fill(oldMaterialInstruction);
  const instructionSaveResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === resourcePath('taskSops', draft.name) &&
    response.request().method() === 'PUT');
  await instructionDialog.getByRole('button', { name: '保存' }).click();
  expect((await instructionSaveResponse).ok()).toBeTruthy();
  await expect(addedStateCard).toContainText(oldMaterialInstruction);
  await expect(instructionButton).not.toHaveClass(/placeholder-value/);

  const materialSaveResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === resourcePath('taskSops', draft.name) &&
    response.request().method() === 'PUT');
  await materialSelect.selectOption(replacementMaterial);
  await expect(addedStateCard.getByRole('combobox', { name: '物料' })).toHaveValue(replacementMaterial);
  expect((await materialSaveResponse).ok()).toBeTruthy();
  await expect(addedStateCard.getByRole('combobox', { name: '物料' })).toHaveValue(replacementMaterial);
  await expect(addedStateCard).not.toContainText(oldMaterialInstruction);
  await expect(instructionButton).toHaveClass(/placeholder-value/);
  await expect(addedStateCard.locator('.state-human-summary')).toHaveText(`把 ${replacementMaterial}。`);
  await expect(addedStateCard.getByText('放在/靠近什么', { exact: true }).locator('..').locator('.single-enum-summary')).toContainText('选择参照物');

  const savedAfterMaterialChange = await getResource(request, 'taskSops', draft.name);
  expect(JSON.stringify(savedAfterMaterialChange.resource)).not.toContain(oldMaterialInstruction);

  await page.getByRole('button', { name: '添加物料' }).click();
  const materialDialog = page.getByRole('dialog', { name: '从物料库添加物料' });
  expect(await materialDialog.locator('.material-reference-status.selected').allTextContents()).toContain('已选择');
  expect(await materialDialog.locator('.material-reference-status.available').allTextContents()).toContain('可添加');
  await materialDialog.getByRole('button', { name: '关闭' }).click();

  const randomizationTable = page.locator('.robot-randomization-table');
  const addRandomization = randomizationTable.getByRole('button', { name: '添加随机性' });
  if (await addRandomization.isEnabled()) {
    const addResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === resourcePath('taskSops', draft.name) &&
      response.request().method() === 'PUT');
    await addRandomization.click();
    expect((await addResponse).ok()).toBeTruthy();
  }

  const randomFieldSelect = randomizationTable.locator('.multi-select-summary');
  await expect(randomFieldSelect).not.toContainText('initial-position-');
  await randomFieldSelect.click();
  const randomFieldOption = page.locator('.multi-select-menu').getByText(randomFieldLabel, { exact: true });
  await expect(randomFieldOption).toBeVisible();
  const randomFieldSave = page.waitForResponse((response) =>
    new URL(response.url()).pathname === resourcePath('taskSops', draft.name) &&
    response.request().method() === 'PUT');
  await randomFieldOption.click();
  expect((await randomFieldSave).ok()).toBeTruthy();

  const saved = await getResource(request, 'taskSops', draft.name);
  expect(saved.resource).toMatchObject({
    spec: {
      randomization: {
        robotInitialState: {
          fields: expect.arrayContaining([
            expect.objectContaining({ displayName: randomFieldLabel }),
          ]),
        },
      },
    },
  });
});

test('collection and annotation steps can be reopened and edited in bulk', async ({ page, request }, testInfo) => {
  const title = `E2E 批量编辑步骤 R${testInfo.retry}`;
  const atomicSkill = `标记抓取 R${testInfo.retry}`;
  await createResource(request, 'globalFields', {
    sourceId: `e2e-atomic-skill-r${testInfo.retry}`,
    group: 'GLOBAL_FIELD_GROUP_ATOMIC_SKILL',
    label: atomicSkill,
    value: atomicSkill,
    startCondition: '夹爪开始闭合',
    endCondition: '物体稳定离开支撑面',
    status: 'GLOBAL_FIELD_STATUS_ACTIVE',
  });
  const template = await firstResource(request, 'taskSops', (item) => !item.archived);
  const templateProto = template.resource;
  if (!templateProto || typeof templateProto !== 'object' || Array.isArray(templateProto) || typeof templateProto.scene !== 'string') {
    throw new TypeError('TaskSop template must identify its Scene');
  }
  const scene = (await listResourceSummaries(request, 'scenes')).find((item) => item.name === templateProto.scene);
  expect(scene, `Expected Scene ${templateProto.scene}`).toBeDefined();
  const draftResource = cloneResourceForCreate(template.resource, {
    displayName: title,
    description: '验证采集与标注步骤批量编辑',
    sourceId: `e2e-bulk-steps-r${testInfo.retry}`,
    legacySubsceneCode: `E2E-BULK-R${testInfo.retry}`,
    legacySubsceneDisplayName: title,
    lifecycle: 'LIFECYCLE_DRAFT',
  });
  if (!draftResource || typeof draftResource !== 'object' || Array.isArray(draftResource)) {
    throw new TypeError('TaskSop draft resource must be an object');
  }
  const draftSpec = draftResource.spec;
  if (!draftSpec || typeof draftSpec !== 'object' || Array.isArray(draftSpec)) {
    throw new TypeError('TaskSop draft resource must contain a spec');
  }
  const draftAnnotation = draftSpec.annotation;
  if (!draftAnnotation || typeof draftAnnotation !== 'object' || Array.isArray(draftAnnotation)) {
    throw new TypeError('TaskSop draft resource must contain an annotation plan');
  }
  const existingAnnotationSteps = Array.isArray(draftAnnotation.steps) ? draftAnnotation.steps : [];
  draftAnnotation.steps = [
    ...existingAnnotationSteps,
    {
      id: `e2e-existing-atomic-skill-r${testInfo.retry}`,
      order: existingAnnotationSteps.length + 1,
      description: '已有的同类标注步骤',
      atomicSkill,
    },
  ];
  const draft = await createResource(request, 'taskSops', draftResource);

  await openAuthenticated(page);
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', {
    name: new RegExp(`^${escapeRegex(scene!.displayName)}\\s+\\d+ 个任务 SOP$`),
  }).click();
  await openTaskSopFromTable(page, title);

  const collectionSection = page.locator('details.collapsible-section').filter({ hasText: '采集步骤和说明' });
  await collectionSection.getByRole('button', { name: '批量输入步骤' }).click();
  let dialog = page.getByRole('dialog', { name: '批量输入步骤' });
  await dialog.getByLabel('中文步骤').fill('拿起牙刷\n放入牙刷杯');
  await dialog.getByLabel('中文原子技能').fill('抓取\n放置');
  await dialog.getByLabel('English Step').fill('Pick up the toothbrush\nPlace it in the cup');
  await dialog.getByLabel('English Atomic Skill').fill('Pick\nPlace');
  let saveResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === resourcePath('taskSops', draft.name) &&
    response.request().method() === 'PUT');
  await dialog.getByRole('button', { name: '保存修改' }).click();
  expect((await saveResponse).ok()).toBeTruthy();
  await expect(collectionSection.locator('.annotation-steps-row')).toHaveCount(2);

  await collectionSection.getByRole('button', { name: '批量输入步骤' }).click();
  dialog = page.getByRole('dialog', { name: '批量输入步骤' });
  await expect(dialog.getByLabel('中文步骤')).toHaveValue('拿起牙刷\n放入牙刷杯');
  await expect(dialog.getByLabel('English Step')).toHaveValue('Pick up the toothbrush\nPlace it in the cup');
  await dialog.getByLabel('中文步骤').fill('拿起洗脸巾');
  await dialog.getByLabel('中文原子技能').fill('抓取');
  await dialog.getByLabel('English Step').fill('Pick up the face towel');
  await dialog.getByLabel('English Atomic Skill').fill('Pick');
  saveResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === resourcePath('taskSops', draft.name) &&
    response.request().method() === 'PUT');
  await dialog.getByRole('button', { name: '保存修改' }).click();
  expect((await saveResponse).ok()).toBeTruthy();
  await expect(collectionSection.locator('.annotation-steps-row')).toHaveCount(1);
  await expect(collectionSection.locator('.annotation-steps-row').first()).toContainText('拿起洗脸巾');

  const annotationSection = page.locator('details.collapsible-section').filter({ hasText: '标注步骤和说明' });
  await annotationSection.getByRole('button', { name: '批量输入步骤' }).click();
  dialog = page.getByRole('dialog', { name: '批量输入步骤' });
  await dialog.getByLabel('中文步骤').fill('标记抓取开始');
  await dialog.getByLabel('中文原子技能').fill(atomicSkill);
  saveResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === resourcePath('taskSops', draft.name) &&
    response.request().method() === 'PUT');
  await dialog.getByRole('button', { name: '保存修改' }).click();
  expect((await saveResponse).ok()).toBeTruthy();
  const generatedRequirement = `${atomicSkill}：开始时机为夹爪开始闭合；结束时机为物体稳定离开支撑面`;
  await expect.poll(
    () => annotationSection.locator('.local-item-list input').evaluateAll(
      (inputs) => inputs.map((input) => (input as HTMLInputElement).value),
    ),
  ).toContain(generatedRequirement);
  await annotationSection.getByRole('button', { name: '批量输入步骤' }).click();
  dialog = page.getByRole('dialog', { name: '批量输入步骤' });
  await expect(dialog.getByLabel('中文步骤')).toHaveValue('标记抓取开始');
  await expect(dialog.getByLabel('中文原子技能')).toHaveValue(atomicSkill);
  await dialog.getByRole('button', { name: '取消' }).click();

  const addAnnotationStep = annotationSection.getByRole('button', { name: '新增步骤' });
  await addAnnotationStep.click();
  const annotationRows = annotationSection.locator('.annotation-steps-row');
  await expect(annotationRows).toHaveCount(2);
  await annotationRows.nth(1).locator('textarea').nth(1).fill('抓取');
  const invalidSaves: number[] = [];
  const recordInvalidSave = (response: { url: () => string; request: () => { method: () => string }; status: () => number }) => {
    if (new URL(response.url()).pathname === resourcePath('taskSops', draft.name) &&
      response.request().method() === 'PUT' && response.status() >= 400) invalidSaves.push(response.status());
  };
  page.on('response', recordInvalidSave);
  await addAnnotationStep.click();
  await page.waitForTimeout(250);
  page.off('response', recordInvalidSave);
  await expect(annotationRows).toHaveCount(3);
  expect(invalidSaves).toEqual([]);
});

test('legacy draft checkpoints remain read-only but can be exported', async ({ page, request }) => {
  const roots = await listResourceSummaries(request, 'taskSops');
  let checkpoint: RevisionSummary | undefined;
  let checkpointRoot: ResourceSummary | undefined;
  for (const root of roots) {
    checkpoint = (await listRevisions(request, 'taskSops', root.name)).find((revision) =>
      revision.origin.endsWith('IMPORTED_DRAFT_CHECKPOINT') && !revision.exportEligible);
    if (checkpoint) {
      checkpointRoot = root;
      break;
    }
  }
  expect(checkpoint, 'Expected the repository fixture to retain at least one legacy TaskSop draft checkpoint').toBeDefined();
  expect(checkpointRoot?.sceneName, 'Expected the checkpoint TaskSop summary to identify its Scene').toBeTruthy();

  const scene = (await listResourceSummaries(request, 'scenes')).find((item) => item.name === checkpointRoot!.sceneName);
  expect(scene, `Expected Scene ${checkpointRoot!.sceneName}`).toBeDefined();
  await openAuthenticated(page);
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', {
    name: new RegExp(`^${escapeRegex(scene!.displayName)}\\s+\\d+ 个任务 SOP$`),
  }).click();
  await openTaskSopFromTable(page, checkpointRoot!.displayName);
  await page.getByTestId('task-sop-version-trigger').click();
  await page.getByTestId(`task-sop-version-${checkpoint!.versionLabel}`).click();
  await expect(page.getByText('这是迁移保留的旧草稿检查点，仅供追踪，不能编辑或确认，可以导出 PDF。')).toBeVisible();
  await expect(page.getByText('导入草稿检查点（只读）')).toBeVisible();
  await expect(page.getByLabel('任务 SOP 名称')).toBeDisabled();
  await expect(page.getByRole('button', { name: '确认任务 SOP' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '删除草稿' })).toHaveCount(0);
  await page.getByRole('button', { name: '导出' }).click();
  await expect(page.getByRole('button', { name: '导出 YAML' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '导出 PDF' })).toBeEnabled();

  const response = await request.get(`/api/revisions/${encodeURIComponent(checkpoint!.name)}/export.yaml`, {
    headers: authHeaders,
  });
  expect(response.status()).toBe(409);
  await expect(response.json()).resolves.toMatchObject({ error: { kind: 'IMMUTABLE_REVISION' } });

  const pdf = await request.get(`/api/revisions/${encodeURIComponent(checkpoint!.name)}/export.pdf`, {
    headers: authHeaders,
  });
  expect(pdf.status()).toBe(200);
  await expect(pdf.json()).resolves.toMatchObject({ rendererVersion: 'sop-pdf-v1' });
});

test('revision export is addressed only by the canonical encoded revision name', async ({ request }) => {
  const roots = await listResourceSummaries(request, 'taskSops');
  let revision: RevisionSummary | undefined;
  for (const root of roots) {
    revision = (await listRevisions(request, 'taskSops', root.name)).find((item) => item.exportEligible);
    if (revision) break;
  }
  expect(revision, 'Expected an exportable TaskSop fixture revision').toBeDefined();

  const yaml = await request.get(`/api/revisions/${encodeURIComponent(revision!.name)}/export.yaml`, {
    headers: authHeaders,
  });
  expect(yaml.ok()).toBe(true);
  expect(yaml.headers()['content-type']).toContain('application/yaml');
  expect(YAML.parse(await yaml.text())).toEqual(expect.objectContaining({
    format: 'coscene.sop.export', schema_version: '2.0.1', task_sop: expect.objectContaining({ status: '已确认' }),
  }));

  const detail = await apiJson<{ name: string; ownerName: string }>(
    request,
    'GET',
    `/api/revisions/${encodeURIComponent(revision!.name)}`,
  );
  expect(detail.name).toBe(revision!.name);
  expect(revision!.name.startsWith(`${detail.ownerName}/revisions/`)).toBe(true);
});
