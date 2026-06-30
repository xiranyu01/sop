import { handleApiRequest } from '../../server/api';
import { createD1Store, type D1DatabaseLike } from '../../server/d1Store';
import { createR2AttachmentStore, type R2BucketLike } from '../../server/r2AttachmentStore';

type Env = {
  DB: D1DatabaseLike;
  ATTACHMENTS?: R2BucketLike;
  APP_PASSWORD?: string;
};

type PagesContext = {
  request: Request;
  env: Env;
};

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
        enabled: Boolean(context.env.ATTACHMENTS),
        message: context.env.ATTACHMENTS ? '' : 'Cloudflare R2 未启用或未绑定 ATTACHMENTS，暂不能上传附件。',
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
    if (!context.env.ATTACHMENTS) {
      return Response.json({ message: '附件存储未配置 R2 binding: ATTACHMENTS' }, { status: 500 });
    }
    const storageKey = decodeURIComponent(attachmentDownload[1]);
    const object = await context.env.ATTACHMENTS.get(storageKey);
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

  const result = await handleApiRequest(createD1Store(context.env.DB, createR2AttachmentStore(context.env.ATTACHMENTS)), {
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
