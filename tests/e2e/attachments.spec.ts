import { expect, test } from '@playwright/test';
import { authHeaders, createResource, firstResource, getResource, openAuthenticated, resourcePath } from './helpers/app';

type AttachmentUploadInit = {
  uid: string;
  uploadId: string;
  objectKey: string;
  partSizeBytes: number;
  partCount: number;
  maxSizeBytes: number;
  publicUrl?: string;
};

type AttachmentMetadata = {
  owner: { scope: string; uid: string };
  uid: string;
  name?: string;
  objectKey: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  publicUrl?: string;
  metadata: Record<string, unknown>;
};

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a ProtoJSON object');
  return value as Record<string, unknown>;
}

function anchoredRowName(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?:\\s|$)`);
}

test('owner-scoped multipart upload completes and unlink removes only owner metadata', async ({ page, request }) => {
  const owner = await firstResource(request, 'materials', (item) => !item.archived);
  const body = Buffer.from('deterministic tiny attachment', 'utf-8');
  const path = `${resourcePath('materials', owner.name)}/attachments`;

  const initResponse = await request.post(path, {
    headers: authHeaders,
    data: {
      filename: 'tiny.txt',
      sizeBytes: body.byteLength,
      mediaType: 'text/plain',
      metadata: { test: 'owner-scoped-e2e' },
    },
  });
  expect(initResponse.status()).toBe(201);
  const initialized = await initResponse.json() as AttachmentUploadInit;
  expect(initialized).toMatchObject({
    uid: expect.stringMatching(/^[a-f0-9-]{36}$/),
    objectKey: `attachments/material/${owner.uid}/${initialized.uid}`,
    partCount: 1,
  });
  expect(initialized.objectKey).not.toContain(owner.name);

  const partResponse = await request.put(`${path}/${encodeURIComponent(initialized.uid)}/parts/1`, {
    headers: { ...authHeaders, 'Content-Type': 'application/octet-stream' },
    data: body,
  });
  expect(partResponse.ok()).toBe(true);
  await expect(partResponse.json()).resolves.toMatchObject({
    partNumber: 1,
    sizeBytes: body.byteLength,
    etag: expect.any(String),
  });

  const completeResponse = await request.post(`${path}/${encodeURIComponent(initialized.uid)}/complete`, {
    headers: authHeaders,
  });
  expect(completeResponse.ok()).toBe(true);
  const completed = await completeResponse.json() as AttachmentMetadata;
  expect(completed).toMatchObject({
    owner: { scope: 'material', uid: owner.uid },
    uid: initialized.uid,
    name: `attachments/${initialized.uid}`,
    objectKey: initialized.objectKey,
    filename: 'tiny.txt',
    mediaType: 'text/plain',
    sizeBytes: body.byteLength,
    metadata: { test: 'owner-scoped-e2e' },
  });

  const metadataResponse = await request.get(`${path}/${encodeURIComponent(initialized.uid)}`, { headers: authHeaders });
  expect(metadataResponse.ok()).toBe(true);
  await expect(metadataResponse.json()).resolves.toMatchObject({
    owner: { scope: 'material', uid: owner.uid },
    uid: initialized.uid,
    objectKey: initialized.objectKey,
  });
  await expect(getResource(request, 'attachments', `attachments/${initialized.uid}`)).resolves.toMatchObject({
    uid: initialized.uid,
    resource: {
      name: `attachments/${initialized.uid}`,
      filename: 'tiny.txt',
      mediaType: 'text/plain',
      storageKey: initialized.objectKey,
    },
  });

  await openAuthenticated(page);
  await page.getByRole('button', { name: /^物料/ }).click();
  await expect(page.getByRole('heading', { name: '物料信息' })).toBeVisible();

  const unlink = await request.delete(`${path}/${encodeURIComponent(initialized.uid)}`, { headers: authHeaders });
  expect(unlink.status()).toBe(204);
  const missingMetadata = await request.get(`${path}/${encodeURIComponent(initialized.uid)}`, { headers: authHeaders });
  expect(missingMetadata.status()).toBe(404);
  // Unlink intentionally does not manage object-byte lifecycle or erase the
  // immutable attachment catalog metadata used by frozen exports.
  await expect(getResource(request, 'attachments', `attachments/${initialized.uid}`)).resolves.toMatchObject({
    uid: initialized.uid,
  });
});

test('Material attachment upload and unlink are both triggered from the page', async ({ page, request }, testInfo) => {
  const suffix = `w${testInfo.workerIndex}-r${testInfo.retry}`;
  const sku = `SKU-E2E-UI-${suffix}`;
  const owner = await createResource(request, 'materials', {
    displayName: `E2E 物料 UI ${suffix}`,
    sourceId: `e2e-material-ui-${suffix}`,
    sku,
    category: 'E2E 物料',
    colors: ['蓝'],
    compositions: ['塑料'],
    packaging: '盒装',
    size: '1cm',
    weight: '1g',
  });
  const filename = `e2e-material-ui-r${testInfo.retry}.png`;
  const ownerPath = resourcePath('materials', owner.name);
  const attachmentPath = `${ownerPath}/attachments`;

  await openAuthenticated(page);
  await page.getByRole('button', { name: /^物料\s+\d+$/ }).click();
  await page.getByPlaceholder('搜索物料名称、编号或字段').fill(sku);
  await page.getByRole('table').getByRole('button', { name: anchoredRowName(sku) }).click();
  let dialog = page.getByRole('dialog', { name: '物料详情' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('SKU 编号')).toHaveValue(sku);

  const chooserPromise = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: '上传图片' }).click();
  const chooser = await chooserPromise;
  const initResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === attachmentPath && response.request().method() === 'POST');
  const completeResponse = page.waitForResponse((response) => {
    const pathname = new URL(response.url()).pathname;
    return pathname.startsWith(`${attachmentPath}/`) && pathname.endsWith('/complete') &&
      response.request().method() === 'POST';
  });
  const linkResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === ownerPath && response.request().method() === 'PUT');
  await chooser.setFiles({
    name: filename,
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  });

  const initializedResponse = await initResponse;
  expect(initializedResponse.status()).toBe(201);
  const initialized = await initializedResponse.json() as AttachmentUploadInit;
  expect((await completeResponse).status()).toBe(200);
  expect((await linkResponse).status()).toBe(200);
  await expect(getResource(request, 'materials', owner.name)).resolves.toMatchObject({
    resource: { images: expect.arrayContaining([`attachments/${initialized.uid}`]) },
  });

  // A full reload clears the in-memory attachment cache. Re-enter through the
  // authenticated material list and prove the persisted reference hydrates
  // its owner-scoped metadata before driving unlink.
  await page.reload();
  await expect(page.getByRole('heading', { name: '物料信息' })).toBeVisible();
  await page.getByPlaceholder('搜索物料名称、编号或字段').fill(sku);
  const metadataResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `${attachmentPath}/${encodeURIComponent(initialized.uid)}` &&
    response.request().method() === 'GET');
  await page.getByRole('table').getByRole('button', { name: anchoredRowName(sku) }).click();
  expect((await metadataResponse).status()).toBe(200);
  dialog = page.getByRole('dialog', { name: '物料详情' });
  const attachmentName = dialog.locator('button.attachment-name-button', { hasText: filename });
  await expect(attachmentName).toBeVisible();
  const attachmentRow = dialog.locator('.attachment-row').filter({ hasText: filename });

  const unlinkRootResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === ownerPath && response.request().method() === 'PUT');
  const unlinkMetadataResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `${attachmentPath}/${encodeURIComponent(initialized.uid)}` &&
    response.request().method() === 'DELETE');
  await attachmentRow.getByRole('button', { name: '删除' }).click();
  expect((await unlinkRootResponse).status()).toBe(200);
  expect((await unlinkMetadataResponse).status()).toBe(204);

  const afterUnlink = objectValue((await getResource(request, 'materials', owner.name)).resource);
  expect(Array.isArray(afterUnlink.images) ? afterUnlink.images : []).not.toContain(`attachments/${initialized.uid}`);
  const missingMetadata = await request.get(`${attachmentPath}/${encodeURIComponent(initialized.uid)}`, { headers: authHeaders });
  expect(missingMetadata.status()).toBe(404);
});
