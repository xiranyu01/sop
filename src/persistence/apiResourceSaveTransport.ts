import type { JsonValue } from '@bufbuild/protobuf';
import type { ResourceDetail, ResourceKind } from '../../shared/transport/resourceDto';
import { ApiClient, ApiClientError } from '../api/client';
import type { QueueFailure } from './saveState';
import type { ResourceSaveTransport } from './resourceSaveQueue';

export type ApiResourceSaveTransportOptions<T> = {
  client: ApiClient;
  kind: ResourceKind;
  encode(value: T): JsonValue;
  decode(value: JsonValue): T;
  onDetail?: (detail: ResourceDetail) => void;
};

function terminal<T>(error: ApiClientError): QueueFailure<T> {
  const violations = error.body?.error.details?.violations ?? [];
  const detail = violations.map((violation) =>
    `${violation.fieldPath} ${violation.message}`).join('；');
  return {
    kind: 'terminal',
    message: detail ? `${error.message}：${detail}` : error.message,
    code: error.body?.error.kind ?? `HTTP_${error.status}`,
  };
}

function retryable<T>(error: ApiClientError): QueueFailure<T> {
  return {
    kind: 'retryable',
    message: error.message,
    // A structured server response proves the request outcome is known. Only
    // transport failures without a response enter the reread-before-retry path.
    unknownOutcome: false,
  };
}

/** Maps the structured resource API contract onto one ResourceSaveQueue. */
export function createApiResourceSaveTransport<T>(
  options: ApiResourceSaveTransportOptions<T>,
): ResourceSaveTransport<T> {
  const readDetail = async (resourceName: string) => {
    const detail = await options.client.get(options.kind, resourceName);
    options.onDetail?.(detail);
    return detail;
  };

  return {
    async read(resourceName) {
      const detail = await readDetail(resourceName);
      return { value: options.decode(detail.resource), etag: detail.etag };
    },

    async save(resourceName, value, expectedEtag) {
      try {
        const result = await options.client.update(options.kind, resourceName, options.encode(value), expectedEtag);
        options.onDetail?.(result.resource);
        return { etag: result.resource.etag, warning: result.warning };
      } catch (error) {
        if (!(error instanceof ApiClientError)) {
          throw {
            kind: 'retryable',
            message: error instanceof Error ? error.message : String(error),
            unknownOutcome: true,
          } satisfies QueueFailure<T>;
        }

        const kind = error.body?.error.kind;
        if (kind === 'STALE_RESOURCE') {
          let server: ResourceDetail;
          try {
            server = await readDetail(resourceName);
          } catch (readError) {
            throw {
              kind: 'retryable',
              message: readError instanceof Error ? readError.message : String(readError),
              unknownOutcome: false,
            } satisfies QueueFailure<T>;
          }
          throw {
            kind: 'conflict',
            message: error.message,
            serverValue: options.decode(server.resource),
            serverEtag: server.etag,
          } satisfies QueueFailure<T>;
        }

        if (kind === 'STORAGE_UNAVAILABLE' || kind === 'ATTACHMENT_PROVIDER' || error.status >= 500) {
          throw retryable<T>(error);
        }
        throw terminal<T>(error);
      }
    },
  };
}
