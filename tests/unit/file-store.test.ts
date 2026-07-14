import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileStore } from '../../server/store';

describe('createFileStore', () => {
  it('keeps data, uploads, and exports inside injected roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sop-store-'));
    const dataDir = path.join(root, 'data');
    const uploadsDir = path.join(root, 'uploads');
    const exportsDir = path.join(root, 'exports');
    const store = createFileStore({ dataDir, uploadsDir, exportsDir });

    expect((await store.readData()).customers).toEqual([]);
    await store.writeCustomers([
      { id: 'cus-test', name: '隔离客户', contact: { name: '联系人', phone: '', email: '' } },
    ]);
    expect(JSON.parse(await readFile(path.join(dataDir, 'customers.json'), 'utf-8'))).toHaveLength(1);

    const upload = await store.createAttachmentUpload!({ storageKey: 'requirements/REQ001/tiny.txt', contentType: 'text/plain' });
    const part = await store.uploadAttachmentPart!({
      storageKey: upload.storageKey,
      uploadId: upload.uploadId,
      partNumber: 1,
      body: new TextEncoder().encode('tiny fixture').buffer,
    });
    await store.completeAttachmentUpload!({
      storageKey: upload.storageKey,
      uploadId: upload.uploadId,
      parts: [{ partNumber: 1, etag: part.etag }],
    });
    expect(await readFile(store.localAttachmentPath(upload.storageKey), 'utf-8')).toBe('tiny fixture');

    const exportFile = await store.writeExport('REQ001', '0.0.1', 'format: baseline\n');
    expect(exportFile).toBe(path.join(exportsDir, 'requirements', 'REQ001', '0.0.1.yaml'));
    expect(await readFile(exportFile, 'utf-8')).toBe('format: baseline\n');
  });

  it('rejects attachment traversal outside the injected upload root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sop-store-'));
    const store = createFileStore({ uploadsDir: path.join(root, 'uploads') });
    expect(() => store.localAttachmentPath('../outside.txt')).toThrow('附件路径无效');
  });
});
