import { expect, test } from '@playwright/test';
import type { AppData, AttachmentUploadInit, RequirementAttachment } from '../../shared/transport/restDto';
import { apiJson, authHeaders, openAuthenticated } from './helpers/app';

test('tiny multipart upload completes, downloads through a real browser trigger, and deletes cleanly', async ({ page, request }) => {
  const body = Buffer.from('deterministic tiny attachment', 'utf-8');
  const init = await apiJson<AttachmentUploadInit>(request, 'POST', '/api/requirements/REQ001/versions/0.0.1/attachments/init', {
    fileName: 'tiny.txt', size: body.byteLength, contentType: 'text/plain',
  });
  const partResponse = await request.put(
    `/api/requirements/REQ001/versions/0.0.1/attachments/${init.uploadId}/parts/1?storageKey=${encodeURIComponent(init.storageKey)}`,
    { headers: { ...authHeaders, 'Content-Type': 'application/octet-stream' }, data: body },
  );
  expect(partResponse.ok()).toBe(true);
  const part = await partResponse.json() as { etag: string };
  const attachment = await apiJson<RequirementAttachment>(
    request,
    'POST',
    `/api/requirements/REQ001/versions/0.0.1/attachments/${init.attachmentId}/complete`,
    { uploadId: init.uploadId, storageKey: init.storageKey, parts: [{ partNumber: 1, etag: part.etag }] },
  );

  await openAuthenticated(page);
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(async ({ storageKey, password }) => {
    const response = await fetch(`/api/attachments/${encodeURIComponent(storageKey)}`, {
      headers: { Authorization: `Bearer ${password}` },
    });
    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = 'tiny.txt';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);
  }, { storageKey: attachment.storageKey, password: 'e2e-password' });
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('tiny.txt');
  expect(await download.createReadStream().then(async (stream) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf-8');
  })).toBe('deterministic tiny attachment');

  const data = await apiJson<AppData>(request, 'GET', '/api/data');
  expect(
    data.requirements[0].versions[0].attachments?.some((item) => item.id === init.attachmentId),
    JSON.stringify({ expectedAttachmentId: init.attachmentId, attachments: data.requirements[0].versions[0].attachments }),
  ).toBe(true);
  await apiJson(request, 'DELETE', `/api/requirements/REQ001/versions/0.0.1/attachments/${init.attachmentId}`);
  const missing = await request.get(`/api/attachments/${encodeURIComponent(init.storageKey)}`, { headers: authHeaders });
  expect(missing.status()).toBe(404);
});
