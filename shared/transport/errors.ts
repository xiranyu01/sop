export type ApiErrorKind =
  | 'UNAUTHORIZED'
  | 'VALIDATION'
  | 'ALREADY_EXISTS'
  | 'STALE_RESOURCE'
  | 'DEPENDENCY_CHANGED'
  | 'ROW_SIZE_REJECTED'
  | 'NOT_INITIALIZED'
  | 'STORAGE_UNAVAILABLE'
  | 'IMMUTABLE_REVISION'
  | 'ATTACHMENT_PROVIDER'
  | 'NOT_FOUND'
  | 'INTERNAL';

export type ApiErrorDetails = {
  resourceKind?: string;
  resourceName?: string;
  expectedEtag?: string;
  actualEtag?: string;
  measuredBytes?: number;
  limitBytes?: number;
  retryable?: boolean;
  violations?: Array<{ fieldPath: string; message: string; ruleId?: string }>;
  dependencyDiff?: unknown;
};

export type ApiErrorBody = {
  error: {
    kind: ApiErrorKind;
    message: string;
    requestId?: string;
    details?: ApiErrorDetails;
  };
};

export function apiError(kind: ApiErrorKind, message: string, details?: ApiErrorDetails, requestId?: string): ApiErrorBody {
  return { error: { kind, message, ...(requestId ? { requestId } : {}), ...(details ? { details } : {}) } };
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (!value || typeof value !== 'object') return false;
  const error = (value as { error?: unknown }).error;
  return Boolean(error && typeof error === 'object' &&
    typeof (error as { kind?: unknown }).kind === 'string' &&
    typeof (error as { message?: unknown }).message === 'string');
}
