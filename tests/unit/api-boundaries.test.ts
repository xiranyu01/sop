import { describe, expect, it, vi } from 'vitest';
import { authorizeApiRequest } from '../../server/http/auth';
import { serializeOperationLog } from '../../server/observability';
import { ApiClient, ApiClientError } from '../../src/api/client';

describe('resource API boundaries', () => {
  it('keeps only health public and uses one protected-route error contract', () => {
    expect(authorizeApiRequest(new Request('https://sop.test/api/health'), undefined)).toEqual({ ok: true, publicRoute: true });
    expect(authorizeApiRequest(new Request('https://sop.test/api/materials'), 'secret')).toMatchObject({
      ok: false, status: 401, body: { error: { kind: 'UNAUTHORIZED' } },
    });
    expect(authorizeApiRequest(new Request('https://sop.test/api/not-found'), undefined)).toMatchObject({
      ok: false, status: 503, body: { error: { kind: 'STORAGE_UNAVAILABLE' } },
    });
  });

  it('emits only allow-listed structured fields', () => {
    const value = serializeOperationLog({
      requestId: 'req-1', operation: 'resource.update', outcome: 'failure', durationMs: 12,
      resourceKind: 'materials', resourceName: 'materials/cup', failureClass: 'D1_UNAVAILABLE',
      // @ts-expect-error regression probe: unknown sensitive input must be dropped.
      authorization: 'Bearer secret', password: 'secret', rawBody: '{"business":"payload"}',
    });
    expect(JSON.parse(value)).toEqual({
      event: 'sop_operation', requestId: 'req-1', operation: 'resource.update', outcome: 'failure', durationMs: 12,
      resourceKind: 'materials', resourceName: 'materials/cup', failureClass: 'D1_UNAVAILABLE',
    });
    expect(value).not.toContain('secret');
    expect(value).not.toContain('payload');
  });

  it('sends resource etags and preserves structured errors', async () => {
    const requestFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { kind: 'STALE_RESOURCE', message: 'stale', details: { actualEtag: 'e2' } },
    }), { status: 409, headers: { 'content-type': 'application/json' } }));
    const client = new ApiClient({ baseUrl: 'https://sop.test', getPassword: () => 'secret', fetch: requestFetch });
    await expect(client.update('materials', 'materials/cup', { displayName: 'Cup' }, 'e1')).rejects.toMatchObject({
      status: 409, body: { error: { kind: 'STALE_RESOURCE', message: 'stale' } },
    } satisfies Partial<ApiClientError>);
    const [url, init] = requestFetch.mock.calls[0];
    expect(url).toBe('https://sop.test/api/resources/materials/materials%2Fcup');
    expect(init.headers.get('authorization')).toBe('Bearer secret');
    expect(JSON.parse(init.body)).toMatchObject({ expectedEtag: 'e1' });
  });

  it('calls browser-style fetch with the global receiver', async () => {
    const requestFetch = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), {
        headers: { 'content-type': 'application/json' },
      }));
    }) as unknown as typeof fetch;
    const client = new ApiClient({ fetch: requestFetch });

    await expect(client.list('materials')).resolves.toEqual({ items: [] });
  });

  it('keeps the binary proxy path as a fallback when direct upload is unavailable', async () => {
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
    const requestFetch = vi.fn()
      .mockResolvedValueOnce(json({
        uid: 'attachment-1', uploadId: 'upload-1', objectKey: 'server/allocated',
        partSizeBytes: 10, partCount: 1, maxSizeBytes: 100, uploadMode: 'proxy',
      }, 201))
      .mockResolvedValueOnce(json({ partNumber: 1, etag: 'part-etag', sizeBytes: 4 }))
      .mockResolvedValueOnce(json({
        owner: { scope: 'material', uid: 'material-uid' }, uid: 'attachment-1', objectKey: 'server/allocated',
        filename: 'photo.png', mediaType: 'image/png', sizeBytes: 4, metadata: {}, name: 'attachments/attachment-1',
      }))
      .mockResolvedValueOnce(json({
        owner: { scope: 'material', uid: 'material-uid' }, uid: 'attachment-1', objectKey: 'server/allocated',
        filename: 'photo.png', mediaType: 'image/png', sizeBytes: 4, metadata: {}, name: 'attachments/attachment-1',
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ApiClient({ baseUrl: 'https://sop.test', getPassword: () => 'secret', fetch: requestFetch });

    const initialized = await client.initializeAttachment('materials', 'materials/cup', {
      filename: 'photo.png', mediaType: 'image/png', sizeBytes: 4,
    });
    const chunk = new Blob(['test'], { type: 'image/png' });
    await client.uploadAttachmentPart('materials', 'materials/cup', initialized.uid, 1, chunk);
    await client.completeAttachment('materials', 'materials/cup', initialized.uid);
    await client.getAttachment('materials', 'materials/cup', initialized.uid);
    await client.unlinkAttachment('materials', 'materials/cup', initialized.uid);

    expect(requestFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://sop.test/api/resources/materials/materials%2Fcup/attachments',
      'https://sop.test/api/resources/materials/materials%2Fcup/attachments/attachment-1/parts/1',
      'https://sop.test/api/resources/materials/materials%2Fcup/attachments/attachment-1/complete',
      'https://sop.test/api/resources/materials/materials%2Fcup/attachments/attachment-1',
      'https://sop.test/api/resources/materials/materials%2Fcup/attachments/attachment-1',
    ]);
    expect(JSON.parse(requestFetch.mock.calls[0][1].body)).toEqual({
      filename: 'photo.png', mediaType: 'image/png', sizeBytes: 4,
    });
    expect(requestFetch.mock.calls[1][1].body).toBe(chunk);
    expect(requestFetch.mock.calls[1][1].headers.get('content-type')).toBe('application/octet-stream');
    expect(requestFetch.mock.calls[1][1].headers.get('authorization')).toBe('Bearer secret');
  });

  it('uploads attachment bytes to a presigned R2 URL without sending the app password', async () => {
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
    const requestFetch = vi.fn()
      .mockResolvedValueOnce(json({ uploadUrl: 'https://r2.example.test/signed', expiresAt: '2026-07-15T00:15:00.000Z' }))
      .mockResolvedValueOnce(new Response(null, { headers: { etag: '"direct-etag"' } }))
      .mockResolvedValueOnce(json({ partNumber: 1, etag: '"direct-etag"', sizeBytes: 4 }));
    const client = new ApiClient({ baseUrl: 'https://sop.test', getPassword: () => 'secret', fetch: requestFetch });
    const chunk = new Blob(['test'], { type: 'image/png' });

    const signed = await client.createAttachmentPartUploadUrl('materials', 'materials/cup', 'attachment-1', 1);
    const etag = await client.uploadAttachmentPartDirect(signed.uploadUrl, chunk);
    await client.recordDirectAttachmentPart('materials', 'materials/cup', 'attachment-1', 1, {
      etag,
      sizeBytes: chunk.size,
    });

    expect(requestFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://sop.test/api/resources/materials/materials%2Fcup/attachments/attachment-1/parts/1/upload-url',
      'https://r2.example.test/signed',
      'https://sop.test/api/resources/materials/materials%2Fcup/attachments/attachment-1/parts/1/receipt',
    ]);
    expect(requestFetch.mock.calls[1][1].headers).toBeUndefined();
    expect(requestFetch.mock.calls[1][1].body).toBe(chunk);
    expect(requestFetch.mock.calls[2][1].headers.get('authorization')).toBe('Bearer secret');
  });
});
