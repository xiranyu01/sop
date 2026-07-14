import { handleApiRequest } from '../../server/api';
import { createCanonicalD1AppStore, createD1Store, type D1DatabaseLike } from '../../server/d1Store';
import { createCanonicalApiStore } from '../../server/domain/services/runtime';
import { bootstrapValidatedD1Generation, readPublishedD1Runtime } from '../../server/migrations/d1RuntimeBootstrap';
import { createR2AttachmentStore, type R2BucketLike } from '../../server/r2AttachmentStore';
import { createS3AttachmentStore, getS3Attachment, hasS3AttachmentConfig, type S3AttachmentConfig } from '../../server/s3AttachmentStore';

type Env = {
  DB: D1DatabaseLike;
  ATTACHMENTS?: R2BucketLike;
  APP_PASSWORD?: string;
  R2_S3_ENDPOINT?: string;
  R2_S3_BUCKET?: string;
  R2_S3_ACCESS_KEY_ID?: string;
  R2_S3_SECRET_ACCESS_KEY?: string;
  R2_PUBLIC_BASE_URL?: string;
  CANONICAL_BOOTSTRAP_MODE?: string;
  CANONICAL_ROLLBACK_LEASE_DAYS?: string;
};

type PagesContext = {
  request: Request;
  env: Env;
  waitUntil?: (promise: Promise<unknown>) => void;
};

const attachmentCleanupBatchSize = 4;

function rollbackLeaseMs(env: Env): number | undefined {
  const value = env.CANONICAL_ROLLBACK_LEASE_DAYS;
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error('CANONICAL_ROLLBACK_LEASE_DAYS must be a positive integer');
  const days = Number(value);
  const milliseconds = days * 24 * 60 * 60_000;
  if (!Number.isSafeInteger(milliseconds) || days < 1) {
    throw new Error('CANONICAL_ROLLBACK_LEASE_DAYS must be a positive safe integer');
  }
  return milliseconds;
}

function s3Config(env: Env): S3AttachmentConfig {
  return {
    endpoint: env.R2_S3_ENDPOINT,
    bucket: env.R2_S3_BUCKET,
    accessKeyId: env.R2_S3_ACCESS_KEY_ID,
    secretAccessKey: env.R2_S3_SECRET_ACCESS_KEY,
  };
}

function attachmentStore(env: Env) {
  if (env.ATTACHMENTS) {
    return createR2AttachmentStore(env.ATTACHMENTS);
  }
  return createS3AttachmentStore(s3Config(env));
}

function attachmentStorageEnabled(env: Env): boolean {
  return Boolean(env.ATTACHMENTS) || hasS3AttachmentConfig(s3Config(env));
}

function isAuthorized(context: PagesContext): boolean {
  return Boolean(context.env.APP_PASSWORD) &&
    context.request.headers.get('authorization') === `Bearer ${context.env.APP_PASSWORD}`;
}

async function getAttachmentObject(env: Env, storageKey: string) {
  if (env.ATTACHMENTS) {
    return env.ATTACHMENTS.get(storageKey);
  }
  if (hasS3AttachmentConfig(s3Config(env))) {
    return getS3Attachment(s3Config(env), storageKey);
  }
  return null;
}

async function scheduleAttachmentCleanup(context: PagesContext, cleanup: () => Promise<unknown>): Promise<void> {
  if (!attachmentStorageEnabled(context.env)) return;
  const work = cleanup().catch((error) => {
    console.error('Attachment cleanup failed; it will be retried.', error instanceof Error ? error.message : String(error));
  });
  if (context.waitUntil) {
    context.waitUntil(work);
    return;
  }
  await work;
}

export const onRequest = async (context: PagesContext): Promise<Response> => {
  const url = new URL(context.request.url);
  if (context.request.method === 'GET' && url.pathname === '/api/storage-status') {
    if (!context.env.APP_PASSWORD) {
      return Response.json({ message: '服务端未配置 APP_PASSWORD' }, { status: 500 });
    }
    if (context.request.headers.get('authorization') !== `Bearer ${context.env.APP_PASSWORD}`) {
      return Response.json({ message: '访问密码无效或已过期' }, { status: 401 });
    }
    return Response.json({
      attachments: {
        enabled: attachmentStorageEnabled(context.env),
        message: attachmentStorageEnabled(context.env) ? '' : '附件存储未配置：请绑定 ATTACHMENTS，或配置 R2 S3 访问参数。',
        publicBaseUrl: context.env.R2_PUBLIC_BASE_URL || '',
      },
    });
  }

  if (!context.env.APP_PASSWORD) {
    return Response.json({ message: '服务端未配置 APP_PASSWORD' }, { status: 500 });
  }
  if (!isAuthorized(context)) {
    return Response.json({ message: '访问密码无效或已过期' }, { status: 401 });
  }

  let body: unknown;
  let rawBody: ArrayBuffer | undefined;
  if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
    if (
      url.pathname.match(/^\/api\/materials\/[^/]+\/images\/[^/]+\/parts\/\d+$/) ||
      url.pathname.match(/^\/api\/requirements\/[^/]+\/versions\/[^/]+\/attachments\/[^/]+\/parts\/\d+$/) ||
      url.pathname.match(/^\/api\/scenes\/[^/]+\/subscenes\/[^/]+\/versions\/[^/]+\/attachments\/[^/]+\/parts\/\d+$/)
    ) {
      rawBody = await context.request.arrayBuffer();
    } else {
      const text = await context.request.text();
      body = text ? JSON.parse(text) : undefined;
    }
  }

  const objects = attachmentStore(context.env);
  const legacyStore = createD1Store(context.env.DB, objects);
  const published = await readPublishedD1Runtime(context.env.DB);
  const migration = published ??
    await bootstrapValidatedD1Generation(context.env.DB, () => legacyStore.readData(), {
      mode: context.env.CANONICAL_BOOTSTRAP_MODE === 'auto' ? 'publish' : 'prepare',
      rollbackAttachmentLeaseMs: rollbackLeaseMs(context.env),
    });
  if (!migration.activated) {
    return Response.json({
      message: 'Canonical generation is validated and write-frozen; explicit cutover activation is required.',
      candidateNamespace: migration.generationId,
    }, { status: 503 });
  }
  const canonicalStore = published?.store ?? createCanonicalD1AppStore(context.env.DB, {
    bootstrap: { namespace: migration.generationId, snapshot: migration.snapshot },
  });
  const apiStore = createCanonicalApiStore(canonicalStore, {
    namespace: migration.generationId,
    attachments: objects,
    writeExport: legacyStore.writeExport.bind(legacyStore),
  });
  const attachmentDownload = url.pathname.match(/^\/api\/attachments\/(.+)$/);
  if (context.request.method === 'GET' && attachmentDownload) {
    if (!attachmentStorageEnabled(context.env)) {
      return Response.json({ message: '附件存储未配置：请绑定 ATTACHMENTS，或配置 R2 S3 访问参数。' }, { status: 500 });
    }
    let storageKey: string;
    try { storageKey = decodeURIComponent(attachmentDownload[1]); } catch {
      return Response.json({ message: '附件路径编码无效' }, { status: 400 });
    }
    const attachment = await apiStore.resolveAttachment(storageKey);
    if (!attachment) return Response.json({ message: '附件不存在或不再可访问' }, { status: 404 });
    const object = await getAttachmentObject(context.env, storageKey);
    if (!object) return Response.json({ message: '找不到附件对象' }, { status: 404 });
    if (migration.writable) await scheduleAttachmentCleanup(context, () => apiStore.cleanupAttachments(attachmentCleanupBatchSize));
    return new Response(object.body, {
      headers: {
        'content-type': object.httpMetadata?.contentType || attachment.mediaType,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      },
    });
  }
  const result = await handleApiRequest(apiStore, {
    method: context.request.method,
    pathname: url.pathname,
    search: url.search,
    body,
    rawBody,
    authorization: context.request.headers.get('authorization'),
    attachmentPublicBaseUrl: context.env.R2_PUBLIC_BASE_URL,
    auth: {
      password: context.env.APP_PASSWORD,
      requireConfigured: true,
    },
  });

  if (result.status === 302 && result.headers?.Location) {
    if (isAuthorized(context) && migration.writable) {
      await scheduleAttachmentCleanup(context, () => apiStore.cleanupAttachments(attachmentCleanupBatchSize));
    }
    return Response.redirect(result.headers.Location, 302);
  }
  if (isAuthorized(context) && migration.writable) {
    await scheduleAttachmentCleanup(context, () => apiStore.cleanupAttachments(attachmentCleanupBatchSize));
  }
  return Response.json(result.body, { status: result.status });
};
