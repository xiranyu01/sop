import { apiError } from '../../shared/transport/errors';
import { authorizeApiRequest } from '../../server/http/auth';
import { handleResourceApiRequest } from '../../server/http/resourceApi';
import { logOperation } from '../../server/observability';
import { createAttachmentService } from '../../server/domain/services/attachment';
import { createD1AttachmentStateStore } from '../../server/repositories/d1AttachmentStateStore';
import { createD1ResourceRepository, type D1DatabaseLike } from '../../server/repositories/d1ResourceRepository';
import { createR2AttachmentStore, type R2BucketLike } from '../../server/r2AttachmentStore';
import type { SaveWarning } from '../../shared/transport/resourceDto';

type Env = {
  // Kept opaque at the authentication boundary so callers cannot be forced to
  // touch/construct the binding before authorization succeeds.
  DB?: unknown;
  ATTACHMENTS?: unknown;
  APP_PASSWORD?: string;
  R2_PUBLIC_BASE_URL?: string;
  [binding: string]: unknown;
};

type PagesContext = {
  request: Request;
  env: Env;
  waitUntil?: (promise: Promise<unknown>) => void;
};

function operationName(method: string, pathname: string): string {
  if (pathname === '/api/health') return 'health.read';
  if (pathname === '/api/readiness') return 'readiness.read';
  if (/\/export\.(?:yaml|pdf)$/.test(pathname)) return `export.${pathname.endsWith('.pdf') ? 'pdf' : 'yaml'}`;
  if (/\/attachments\/[^/]+\/parts\/[^/]+\/?$/.test(pathname)) return 'attachment.upload-part';
  if (/\/attachments\/[^/]+\/complete\/?$/.test(pathname)) return 'attachment.complete';
  if (/\/attachments\/[^/]+\/abort\/?$/.test(pathname)) return 'attachment.abort';
  if (/\/attachments\/[^/]+\/?$/.test(pathname)) {
    if (method === 'DELETE') return 'attachment.unlink';
    return 'attachment.metadata';
  }
  if (/\/attachments\/?$/.test(pathname) && method === 'POST') return 'attachment.initialize';
  if (pathname.startsWith('/api/revisions/')) return 'revision.read';
  if (/\/review-proposal\/?$/.test(pathname)) return 'lifecycle.review-proposal';
  if (/\/review-acknowledgements\/?$/.test(pathname)) return 'lifecycle.acknowledge-review';
  if (/\/confirmations\/?$/.test(pathname)) return 'lifecycle.confirm';
  if (/\/revisions\/?$/.test(pathname)) return 'revision.list';
  if (/\/archive\/?$/.test(pathname)) return 'resource.archive';
  if (/\/drafts\/?$/.test(pathname)) {
    return method === 'DELETE' ? 'lifecycle.discard-draft' : 'lifecycle.start-draft';
  }
  if (method === 'POST') return 'resource.create';
  if (method === 'PUT') return 'resource.update';
  if (method === 'GET') return pathname.split('/').length > 4 ? 'resource.read' : 'resource.list';
  return 'api.request';
}

function operationResource(pathname: string): { resourceKind?: string; resourceName?: string } {
  const resource = /^\/api\/resources\/([^/]+)(?:\/([^/]+))?/.exec(pathname);
  if (resource) {
    let resourceName: string | undefined;
    try { resourceName = resource[2] ? decodeURIComponent(resource[2]) : undefined; } catch { /* invalid names stay unlogged */ }
    return { resourceKind: resource[1], resourceName };
  }
  const revision = /^\/api\/revisions\/([^/]+)/.exec(pathname);
  if (revision) {
    try { return { resourceKind: 'revision', resourceName: decodeURIComponent(revision[1]) }; } catch { /* invalid names stay unlogged */ }
  }
  return {};
}

function logResult(input: {
  requestId: string;
  operation: string;
  status: number;
  startedAt: number;
  warning?: SaveWarning;
  resourceKind?: string;
  resourceName?: string;
}): void {
  logOperation(console, {
    requestId: input.requestId,
    operation: input.operation,
    outcome: input.status < 400 ? 'success' : input.status < 500 ? 'rejected' : 'failure',
    durationMs: Math.max(0, Date.now() - input.startedAt),
    failureClass: input.status >= 500 ? 'D1_OR_READINESS' : undefined,
    rowSizeOutcome: input.warning ? (input.status === 413 ? 'rejected' : 'warning') : undefined,
    measuredBytes: input.warning?.measuredBytes,
    resourceKind: input.resourceKind,
    resourceName: input.resourceName,
  });
}

export const onRequest = async (context: PagesContext): Promise<Response> => {
  const startedAt = Date.now();
  const requestId = context.request.headers.get('cf-ray') || crypto.randomUUID();
  const url = new URL(context.request.url);
  const operation = operationName(context.request.method.toUpperCase(), url.pathname);
  const resource = operationResource(url.pathname);

  // This is intentionally the first boundary: no body parsing, DB binding, or
  // attachment provider access may occur before it returns success.
  const auth = authorizeApiRequest(context.request, context.env.APP_PASSWORD);
  if (!auth.ok) {
    const response = Response.json(auth.body, { status: auth.status });
    logResult({ requestId, operation, status: response.status, startedAt, ...resource });
    return response;
  }
  if (auth.publicRoute) {
    const response = new Response(null, { status: 204 });
    logResult({ requestId, operation, status: response.status, startedAt, ...resource });
    return response;
  }

  let warning: SaveWarning | undefined;
  try {
    const database = context.env.DB;
    if (!database) throw new TypeError('DB binding is not configured');
    const repository = createD1ResourceRepository(database as D1DatabaseLike, {
      onRowSizeWarning(value) {
        warning = {
          kind: 'row_size',
          resourceName: value.resourceName,
          measuredBytes: value.bytes,
          limitBytes: value.rejectionLimitBytes,
        };
      },
    });
    const response = await handleResourceApiRequest(context.request, repository, {
      requestId,
      readRowSizeWarning: () => warning,
      createAttachmentService: () => createAttachmentService({
        state: createD1AttachmentStateStore(database as D1DatabaseLike),
        provider: createR2AttachmentStore(context.env.ATTACHMENTS as R2BucketLike | undefined),
        publicBaseUrl: context.env.R2_PUBLIC_BASE_URL,
      }),
    });
    logResult({ requestId, operation, status: response.status, startedAt, warning, ...resource });
    return response;
  } catch {
    const response = Response.json(
      apiError('STORAGE_UNAVAILABLE', '资源存储暂时不可用', { retryable: true }, requestId),
      { status: 500 },
    );
    logResult({ requestId, operation, status: response.status, startedAt, warning, ...resource });
    return response;
  }
};
