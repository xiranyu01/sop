import { handleApiRequest } from '../../server/api';
import { createD1Store, type D1DatabaseLike } from '../../server/d1Store';
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
};

type PagesContext = {
  request: Request;
  env: Env;
};

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

async function getAttachmentObject(env: Env, storageKey: string) {
  if (env.ATTACHMENTS) {
    return env.ATTACHMENTS.get(storageKey);
  }
  if (hasS3AttachmentConfig(s3Config(env))) {
    return getS3Attachment(s3Config(env), storageKey);
  }
  return null;
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
      },
    });
  }

  const attachmentDownload = url.pathname.match(/^\/api\/attachments\/(.+)$/);
  if (context.request.method === 'GET' && attachmentDownload) {
    if (!context.env.APP_PASSWORD) {
      return Response.json({ message: '服务端未配置 APP_PASSWORD' }, { status: 500 });
    }
    if (context.request.headers.get('authorization') !== `Bearer ${context.env.APP_PASSWORD}`) {
      return Response.json({ message: '访问密码无效或已过期' }, { status: 401 });
    }
    if (!attachmentStorageEnabled(context.env)) {
      return Response.json({ message: '附件存储未配置：请绑定 ATTACHMENTS，或配置 R2 S3 访问参数。' }, { status: 500 });
    }
    const storageKey = decodeURIComponent(attachmentDownload[1]);
    const object = await getAttachmentObject(context.env, storageKey);
    if (!object) {
      return Response.json({ message: '找不到附件' }, { status: 404 });
    }
    return new Response(object.body, {
      headers: {
        'content-type': object.httpMetadata?.contentType || 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(storageKey.split('/').at(-1) || 'attachment')}`,
      },
    });
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

  const result = await handleApiRequest(createD1Store(context.env.DB, attachmentStore(context.env)), {
    method: context.request.method,
    pathname: url.pathname,
    search: url.search,
    body,
    rawBody,
    authorization: context.request.headers.get('authorization'),
    auth: {
      password: context.env.APP_PASSWORD,
      requireConfigured: true,
    },
  });

  if (result.status === 302 && result.headers?.Location) {
    return Response.redirect(result.headers.Location, 302);
  }
  return Response.json(result.body, { status: result.status });
};
