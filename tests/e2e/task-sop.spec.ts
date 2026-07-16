import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
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
  await page.getByRole('button', { name: new RegExp(`^${title} v0\\.0\\.1 · 草稿$`) }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.locator('.version-time-meta')).toContainText('创建时间');
  await expect(page.locator('.version-time-meta')).toContainText('更新时间');
  await expect(page.getByRole('button', { name: '加载更多全局字段' })).toHaveCount(0);

  await page.getByRole('button', { name: '导出' }).click();
  await expect(page.getByRole('button', { name: '导出 PDF' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '导出 YAML' })).toBeDisabled();
  await page.getByRole('button', { name: '导出 PDF' }).click();
  await expect(page.frameLocator('iframe[title$=".pdf"]').locator('body')).toContainText(title);

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
  await page.getByRole('button', { name: new RegExp(`^${title} v0\\.0\\.1 · 已确认$`) }).click();
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
  const pdfFrame = page.frameLocator('iframe[title$=".pdf"]');
  await expect(pdfFrame.locator('body')).toContainText(title);
  await expect(pdfFrame.locator('body')).toContainText('0.0.1');
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

  const deleteDraftResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === draftPath && response.request().method() === 'DELETE');
  await page.getByRole('button', { name: '删除草稿' }).click();
  expect((await deleteDraftResponse).ok()).toBeTruthy();
  await expect(page.getByText('草稿版本已删除')).toBeVisible();
  await expect(page.getByTestId('task-sop-version-trigger')).toContainText('v0.0.1');
  await expect(page.getByText('当前任务 SOP 已确认')).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', {
    name: new RegExp(`^${escapeRegex(scene!.displayName)}\\s+\\d+ 个任务 SOP$`),
  }).click();
  await page.getByRole('button', { name: new RegExp(`^${title} v0\\.0\\.1 · 已确认$`) }).click();
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
  const draft = await createResource(request, 'taskSops', cloneResourceForCreate(template.resource, {
    displayName: title,
    description: '机器人初始态保存回归测试',
    sourceId: `e2e-robot-initial-state-r${testInfo.retry}`,
    legacySubsceneCode: `E2E-ROBOT-INITIAL-R${testInfo.retry}`,
    legacySubsceneDisplayName: title,
    lifecycle: 'LIFECYCLE_DRAFT',
  }));

  await openAuthenticated(page);
  await page.getByRole('button', { name: /^场景库/ }).click();
  await page.getByRole('button', {
    name: new RegExp(`^${escapeRegex(scene!.displayName)}\\s+\\d+ 个任务 SOP$`),
  }).click();
  await page.getByRole('button', { name: new RegExp(`^${title} v0\\.0\\.1 · 草稿$`) }).click();

  const select = page.getByRole('combobox', { name: '机器人初始态', exact: true });
  await expect(select.locator('option[value=""]')).toHaveAttribute('hidden', '');
  const updateResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === resourcePath('taskSops', draft.name) &&
    response.request().method() === 'PUT');
  await select.selectOption({ label: '机器人处于安全初始位' });
  expect((await updateResponse).ok()).toBeTruthy();
  await expect(select).toHaveValue('机器人处于安全初始位');
  await expect(page.locator('.save-state-stack')).toBeHidden();

  const initialStateCard = page.locator('[data-state-kind="initial"][data-state-index="0"]');
  await expect(initialStateCard.locator('.state-card-detail')).toBeVisible();
  await initialStateCard.getByRole('button', { name: '收起字段' }).click();
  await expect(initialStateCard.locator('.state-card-detail')).toBeHidden();
  await expect(initialStateCard.getByRole('button', { name: '展开编辑' })).toBeVisible();

  const initialStateSection = page.locator('[data-state-section="initial"]');
  await expect(initialStateSection.locator('.embedded-table-header')).toHaveCSS('position', 'sticky');
  await expect(initialStateSection.locator('.embedded-table-header')).toHaveCSS('top', '8px');
  const initialCardCount = await initialStateSection.locator('[data-state-kind="initial"]').count();
  const addStateResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === resourcePath('taskSops', draft.name) &&
    response.request().method() === 'PUT');
  await initialStateSection.getByRole('button', { name: '添加状态' }).click();
  expect((await addStateResponse).ok()).toBeTruthy();
  const addedStateCard = initialStateSection.locator(`[data-state-index="${initialCardCount}"]`);
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

  const materialRandomizationSummary = page.locator(
    '[data-state-kind="material-randomization"][data-state-index="0"] .state-human-summary',
  );
  await expect(materialRandomizationSummary).toContainText('物料位置');
  await expect(materialRandomizationSummary).toContainText('物料姿态');
  await expect(materialRandomizationSummary).toContainText('物料形态');
  await expect(materialRandomizationSummary).not.toContainText('location');

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
  await page.getByRole('button', {
    name: new RegExp(`^${escapeRegex(checkpointRoot!.displayName)} v`),
  }).first().click();
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
