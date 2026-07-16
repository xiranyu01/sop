import { AwsClient } from 'aws4fetch';
import type {
  AttachmentAbortInput,
  AttachmentCompleteInput,
  AttachmentObject,
  AttachmentObjectMetadata,
  AttachmentObjectStore,
  AttachmentPartInput,
  AttachmentPartOutput,
  AttachmentPartUploadUrlInput,
  AttachmentPartUploadUrlOutput,
  AttachmentUploadInput,
  AttachmentUploadSession,
} from './domain/attachmentObjectStore';
import {
  assertExpectedObjectSize,
  normalizeAttachmentComplete,
  validateAttachmentPart,
  validateAttachmentUpload,
  validateStorageKey,
  validateUploadSession,
} from './domain/attachmentObjectStore';

export type S3AttachmentConfig = {
  endpoint?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  directUploadEnabled?: boolean;
  /** Injectable signed-request transport for adapter contract tests. */
  request?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

type S3ClientContext = {
  request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  sign: (input: RequestInfo | URL, init?: RequestInit & { aws?: { signQuery?: boolean } }) => Promise<Request>;
  endpoint: string;
  bucket: string;
};

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

export function hasS3AttachmentConfig(config: S3AttachmentConfig): boolean {
  return Boolean(config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey);
}

function requireS3Context(config: S3AttachmentConfig): S3ClientContext {
  if (!hasS3AttachmentConfig(config)) {
    throw new Error('附件存储未配置 R2 S3 访问参数');
  }
  const aws = new AwsClient({
      accessKeyId: config.accessKeyId || '',
      secretAccessKey: config.secretAccessKey || '',
      service: 's3',
      region: 'auto',
    });
  return {
    request: config.request ?? ((input, init) => aws.fetch(input, init)),
    sign: (input, init) => aws.sign(input, init),
    endpoint: normalizeEndpoint(config.endpoint || ''),
    bucket: config.bucket || '',
  };
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function objectUrl(context: S3ClientContext, key: string, search = ''): string {
  return `${context.endpoint}/${encodeURIComponent(context.bucket)}/${encodeKey(key)}${search}`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function parseUploadId(xml: string): string {
  const match = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
  if (!match?.[1]) {
    throw new Error('R2 S3 未返回 UploadId');
  }
  return match[1];
}

async function assertOk(response: Response, action: string): Promise<Response> {
  if (response.ok) {
    return response;
  }
  const text = await response.text().catch(() => '');
  throw new Error(`${action}失败：${response.status}${text ? ` ${text.slice(0, 240)}` : ''}`);
}

export async function getS3Attachment(config: S3AttachmentConfig, storageKey: string): Promise<AttachmentObject | null> {
  validateStorageKey(storageKey);
  const context = requireS3Context(config);
  const response = await context.request(objectUrl(context, storageKey), { method: 'GET' });
  if (response.status === 404) {
    return null;
  }
  await assertOk(response, '下载附件');
  if (!response.body) {
    return null;
  }
  return {
    body: response.body,
    metadata: responseMetadata(storageKey, response.headers),
    httpMetadata: {
      contentType: response.headers.get('content-type') || undefined,
    },
  };
}

function responseMetadata(storageKey: string, headers: Headers): AttachmentObjectMetadata {
  const size = Number(headers.get('content-length'));
  if (!Number.isSafeInteger(size) || size < 0 || headers.get('content-length') === null) {
    throw new Error('S3 object metadata is missing actual size');
  }
  const sha256Header = headers.get('x-amz-meta-sha256') || headers.get('x-amz-checksum-sha256') || undefined;
  let sha256: string | undefined;
  if (sha256Header && /^[a-f0-9]{64}$/i.test(sha256Header)) {
    sha256 = sha256Header.toLowerCase();
  } else if (sha256Header) {
    try {
      const bytes = Uint8Array.from(atob(sha256Header), (character) => character.charCodeAt(0));
      if (bytes.byteLength === 32) sha256 = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
      // Ignore malformed optional checksum metadata; size remains authoritative.
    }
  }
  return {
    storageKey,
    sizeBytes: size,
    contentType: headers.get('content-type') || undefined,
    etag: headers.get('etag') || undefined,
    sha256,
  };
}

export async function headS3Attachment(config: S3AttachmentConfig, storageKey: string): Promise<AttachmentObjectMetadata | null> {
  validateStorageKey(storageKey);
  const context = requireS3Context(config);
  const response = await context.request(objectUrl(context, storageKey), { method: 'HEAD' });
  if (response.status === 404) return null;
  await assertOk(response, '查询附件');
  return responseMetadata(storageKey, response.headers);
}

export function createS3AttachmentStore(config: S3AttachmentConfig): AttachmentObjectStore {
  return {
    async createAttachmentUpload(input: AttachmentUploadInput): Promise<AttachmentUploadSession> {
      validateAttachmentUpload(input);
      const context = requireS3Context(config);
      const response = await context.request(objectUrl(context, input.storageKey, '?uploads'), {
        method: 'POST',
        headers: { 'content-type': input.contentType || 'application/octet-stream' },
      });
      await assertOk(response, '初始化附件上传');
      return { uploadId: parseUploadId(await response.text()), storageKey: input.storageKey };
    },
    createAttachmentPartUploadUrl: config.directUploadEnabled === false ? undefined : async (
      input: AttachmentPartUploadUrlInput,
    ): Promise<AttachmentPartUploadUrlOutput> => {
      validateUploadSession(input);
      if (!Number.isInteger(input.partNumber) || input.partNumber < 1) throw new Error('part number is invalid');
      if (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds < 1 || input.expiresInSeconds > 3600) {
        throw new Error('upload URL expiry is invalid');
      }
      const context = requireS3Context(config);
      const search = `?partNumber=${input.partNumber}&uploadId=${encodeURIComponent(input.uploadId)}` +
        `&X-Amz-Expires=${input.expiresInSeconds}`;
      const request = await context.sign(objectUrl(context, input.storageKey, search), {
        method: 'PUT',
        aws: { signQuery: true },
      });
      return {
        uploadUrl: request.url,
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
      };
    },
    async uploadAttachmentPart(input: AttachmentPartInput): Promise<AttachmentPartOutput> {
      validateAttachmentPart(input);
      const context = requireS3Context(config);
      const search = `?partNumber=${input.partNumber}&uploadId=${encodeURIComponent(input.uploadId)}`;
      const response = await context.request(objectUrl(context, input.storageKey, search), {
        method: 'PUT',
        body: input.body,
      });
      await assertOk(response, '上传附件分片');
      const etag = response.headers.get('etag');
      if (!etag) {
        throw new Error('R2 S3 未返回分片 ETag');
      }
      return { etag };
    },
    async completeAttachmentUpload(input: AttachmentCompleteInput): Promise<void> {
      const normalized = normalizeAttachmentComplete(input);
      const existing = await headS3Attachment(config, input.storageKey);
      if (existing) {
        assertExpectedObjectSize(existing, input.expectedSizeBytes);
        return;
      }
      const context = requireS3Context(config);
      const parts = normalized
        .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`)
        .join('');
      const response = await context.request(objectUrl(context, input.storageKey, `?uploadId=${encodeURIComponent(input.uploadId)}`), {
        method: 'POST',
        headers: { 'content-type': 'application/xml' },
        body: `<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`,
      });
      await assertOk(response, '完成附件上传');
      assertExpectedObjectSize(await headS3Attachment(config, input.storageKey), input.expectedSizeBytes);
    },
    async abortAttachmentUpload(input: AttachmentAbortInput): Promise<void> {
      validateUploadSession(input);
      const context = requireS3Context(config);
      const response = await context.request(objectUrl(context, input.storageKey, `?uploadId=${encodeURIComponent(input.uploadId)}`), {
        method: 'DELETE',
      });
      if (response.status === 404) return;
      await assertOk(response, '取消附件上传');
    },
    async deleteAttachment(storageKey: string): Promise<void> {
      validateStorageKey(storageKey);
      const context = requireS3Context(config);
      const response = await context.request(objectUrl(context, storageKey), { method: 'DELETE' });
      if (response.status === 404) return;
      await assertOk(response, '删除附件');
    },
    getAttachment(storageKey: string) {
      return getS3Attachment(config, storageKey);
    },
    headAttachment(storageKey: string) {
      return headS3Attachment(config, storageKey);
    },
    async attachmentExists(storageKey: string) {
      return (await headS3Attachment(config, storageKey)) !== null;
    },
  };
}
