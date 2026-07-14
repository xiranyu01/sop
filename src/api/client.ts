import type { JsonValue } from '@bufbuild/protobuf';
import { isApiErrorBody, type ApiErrorBody } from '../../shared/transport/errors';
import type {
  ResourceDetail,
  ResourceKind,
  ResourceMutationResult,
  ResourcePage,
  RevisionSummary,
} from '../../shared/transport/resourceDto';

export class ApiClientError extends Error {
  readonly status: number;
  readonly body?: ApiErrorBody;

  constructor(status: number, body?: ApiErrorBody) {
    super(body?.error.message ?? `HTTP ${status}`);
    this.name = 'ApiClientError';
    this.status = status;
    this.body = body;
  }
}

export type ApiClientOptions = {
  baseUrl?: string;
  getPassword?: () => string | undefined;
  fetch?: typeof fetch;
};

export class ApiClient {
  private readonly baseUrl: string;
  private readonly getPassword: () => string | undefined;
  private readonly requestFetch: typeof fetch;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '';
    this.getPassword = options.getPassword ?? (() => undefined);
    this.requestFetch = options.fetch ?? fetch;
  }

  health(): Promise<{ ok: boolean; initialized: boolean }> {
    return this.request('/api/health', { authenticated: false });
  }

  readiness(): Promise<{ ready: boolean; reason?: string }> {
    return this.request('/api/readiness');
  }

  list(kind: ResourceKind, options: { pageSize?: number; cursor?: string } = {}): Promise<ResourcePage> {
    const query = new URLSearchParams();
    if (options.pageSize !== undefined) query.set('pageSize', String(options.pageSize));
    if (options.cursor) query.set('cursor', options.cursor);
    return this.request(`/api/resources/${kind}${query.size ? `?${query}` : ''}`);
  }

  get(kind: ResourceKind, name: string): Promise<ResourceDetail> {
    return this.request(`/api/resources/${kind}/${encodeURIComponent(name)}`);
  }

  create(kind: ResourceKind, resource: JsonValue): Promise<ResourceMutationResult> {
    return this.request(`/api/resources/${kind}`, { method: 'POST', body: { resource } });
  }

  update(kind: ResourceKind, name: string, resource: JsonValue, expectedEtag: string): Promise<ResourceMutationResult> {
    return this.request(`/api/resources/${kind}/${encodeURIComponent(name)}`, {
      method: 'PUT', body: { resource, expectedEtag },
    });
  }

  archive(kind: ResourceKind, name: string, expectedEtag: string): Promise<ResourceMutationResult> {
    return this.request(`/api/resources/${kind}/${encodeURIComponent(name)}/archive`, {
      method: 'POST', body: { expectedEtag },
    });
  }

  revisions(kind: 'taskSops' | 'requirements' | 'robotModels', name: string): Promise<{ items: RevisionSummary[] }> {
    return this.request(`/api/resources/${kind}/${encodeURIComponent(name)}/revisions`);
  }

  async request<T>(path: string, options: {
    method?: string;
    body?: unknown;
    authenticated?: boolean;
    signal?: AbortSignal;
  } = {}): Promise<T> {
    const headers = new Headers();
    if (options.authenticated !== false) {
      const password = this.getPassword();
      if (password) headers.set('authorization', `Bearer ${password}`);
    }
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    const response = await this.requestFetch(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    const contentType = response.headers.get('content-type') ?? '';
    const value = contentType.includes('application/json') ? await response.json() : undefined;
    if (!response.ok) throw new ApiClientError(response.status, isApiErrorBody(value) ? value : undefined);
    return value as T;
  }
}

