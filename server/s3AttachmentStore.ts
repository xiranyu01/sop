import { AwsClient } from 'aws4fetch';
import type {
  AttachmentAbortInput,
  AttachmentCompleteInput,
  AttachmentPartInput,
  AttachmentPartOutput,
  AttachmentUploadInput,
  AttachmentUploadSession,
} from './domain/attachmentObjectStore';
import type { AttachmentObject, AttachmentStore } from './r2AttachmentStore';

export type S3AttachmentConfig = {
  endpoint?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
};

type S3ClientContext = {
  aws: AwsClient;
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
  return {
    aws: new AwsClient({
      accessKeyId: config.accessKeyId || '',
      secretAccessKey: config.secretAccessKey || '',
      service: 's3',
      region: 'auto',
    }),
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
  const context = requireS3Context(config);
  const response = await context.aws.fetch(objectUrl(context, storageKey), { method: 'GET' });
  if (response.status === 404) {
    return null;
  }
  await assertOk(response, '下载附件');
  if (!response.body) {
    return null;
  }
  return {
    body: response.body,
    httpMetadata: {
      contentType: response.headers.get('content-type') || undefined,
    },
  };
}

export function createS3AttachmentStore(config: S3AttachmentConfig): AttachmentStore {
  return {
    async createAttachmentUpload(input: AttachmentUploadInput): Promise<AttachmentUploadSession> {
      const context = requireS3Context(config);
      const response = await context.aws.fetch(objectUrl(context, input.storageKey, '?uploads'), {
        method: 'POST',
        headers: { 'content-type': input.contentType || 'application/octet-stream' },
      });
      await assertOk(response, '初始化附件上传');
      return { uploadId: parseUploadId(await response.text()), storageKey: input.storageKey };
    },
    async uploadAttachmentPart(input: AttachmentPartInput): Promise<AttachmentPartOutput> {
      const context = requireS3Context(config);
      const search = `?partNumber=${input.partNumber}&uploadId=${encodeURIComponent(input.uploadId)}`;
      const response = await context.aws.fetch(objectUrl(context, input.storageKey, search), {
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
      const context = requireS3Context(config);
      const parts = input.parts
        .slice()
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`)
        .join('');
      const response = await context.aws.fetch(objectUrl(context, input.storageKey, `?uploadId=${encodeURIComponent(input.uploadId)}`), {
        method: 'POST',
        headers: { 'content-type': 'application/xml' },
        body: `<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`,
      });
      await assertOk(response, '完成附件上传');
    },
    async abortAttachmentUpload(input: AttachmentAbortInput): Promise<void> {
      const context = requireS3Context(config);
      const response = await context.aws.fetch(objectUrl(context, input.storageKey, `?uploadId=${encodeURIComponent(input.uploadId)}`), {
        method: 'DELETE',
      });
      await assertOk(response, '取消附件上传');
    },
    async deleteAttachment(storageKey: string): Promise<void> {
      const context = requireS3Context(config);
      const response = await context.aws.fetch(objectUrl(context, storageKey), { method: 'DELETE' });
      await assertOk(response, '删除附件');
    },
  };
}
