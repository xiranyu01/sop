import type { JsonValue } from '@bufbuild/protobuf';
import { isApiErrorBody, type ApiErrorBody } from '../../shared/transport/errors';
import type {
  ConfirmationResult,
  ResourceDetail,
  ResourceKind,
  ResourceMutationResult,
  ResourcePage,
  RevisionDetail,
  RevisionSummary,
} from '../../shared/transport/resourceDto';

export type { ConfirmationResult } from '../../shared/transport/resourceDto';

export type DependencyDiffItem = {
  kind: string | number;
  resourceName: string;
  beforeToken?: string;
  afterToken?: string;
};

export type DependencyReviewProposal = {
  proposalDigest: string;
  rootEtag: string;
  rootName?: string;
  dependencies?: Array<{ kind: string | number; resourceName: string; token: string }>;
  empty?: boolean;
  added: DependencyDiffItem[];
  changed: DependencyDiffItem[];
  removed: DependencyDiffItem[];
};

export type AttachmentOwnerResourceKind = 'materials' | 'taskSops' | 'requirements';

export type AttachmentUploadInput = {
  filename: string;
  mediaType: string;
  sizeBytes: number;
  publicUrl?: string;
  metadata?: Record<string, unknown>;
};

export type AttachmentUploadSession = {
  uid: string;
  uploadId: string;
  objectKey: string;
  partSizeBytes: number;
  partCount: number;
  maxSizeBytes: number;
  publicUrl?: string;
};

export type AttachmentPartReceipt = {
  partNumber: number;
  etag: string;
  sizeBytes: number;
};

export type AttachmentMetadata = {
  owner: { scope: 'material' | 'task_sop' | 'requirement'; uid: string };
  uid: string;
  objectKey: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  publicUrl?: string;
  metadata: Record<string, unknown>;
  name?: string;
};

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
    // Window.fetch is brand-checked in browsers. Binding it here prevents the
    // class property call from using ApiClient as the native receiver.
    this.requestFetch = (options.fetch ?? globalThis.fetch).bind(globalThis);
  }

  list(kind: ResourceKind, options: { pageSize?: number; cursor?: string } = {}): Promise<ResourcePage> {
    const query = new URLSearchParams();
    if (options.pageSize !== undefined) query.set('pageSize', String(options.pageSize));
    if (options.cursor) query.set('cursor', options.cursor);
    return this.request(`/api/resources/${kind}${query.size ? `?${query}` : ''}`);
  }

  /**
   * Traverses summary pages without fetching any detail Proto payloads.
   * Consumers decide when to stop and when an opened row needs get().
   */
  async *listPages(
    kind: ResourceKind,
    options: { pageSize?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<ResourcePage, void, void> {
    let cursor: string | undefined;
    const visited = new Set<string>();
    do {
      if (cursor && visited.has(cursor)) throw new Error(`Resource pagination cursor repeated for ${kind}`);
      if (cursor) visited.add(cursor);
      const query = new URLSearchParams();
      if (options.pageSize !== undefined) query.set('pageSize', String(options.pageSize));
      if (cursor) query.set('cursor', cursor);
      const page = await this.request<ResourcePage>(`/api/resources/${kind}${query.size ? `?${query}` : ''}`, {
        signal: options.signal,
      });
      yield page;
      cursor = page.nextCursor;
    } while (cursor);
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

  revisions(
    kind: 'taskSops' | 'requirements' | 'robotModels',
    name: string,
    options: { pageSize?: number; cursor?: string } = {},
  ): Promise<{ items: RevisionSummary[]; nextCursor?: string }> {
    const query = new URLSearchParams();
    if (options.pageSize !== undefined) query.set('pageSize', String(options.pageSize));
    if (options.cursor) query.set('cursor', options.cursor);
    return this.request(
      `/api/resources/${kind}/${encodeURIComponent(name)}/revisions${query.size ? `?${query}` : ''}`,
    );
  }

  async *revisionPages(
    kind: 'taskSops' | 'requirements' | 'robotModels',
    name: string,
    options: { pageSize?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<{ items: RevisionSummary[]; nextCursor?: string }, void, void> {
    let cursor: string | undefined;
    const visited = new Set<string>();
    do {
      if (cursor && visited.has(cursor)) throw new Error(`Revision pagination cursor repeated for ${name}`);
      if (cursor) visited.add(cursor);
      const query = new URLSearchParams();
      if (options.pageSize !== undefined) query.set('pageSize', String(options.pageSize));
      if (cursor) query.set('cursor', cursor);
      const page = await this.request<{ items: RevisionSummary[]; nextCursor?: string }>(
        `/api/resources/${kind}/${encodeURIComponent(name)}/revisions${query.size ? `?${query}` : ''}`,
        { signal: options.signal },
      );
      yield page;
      cursor = page.nextCursor;
    } while (cursor);
  }

  getRevision(name: string): Promise<RevisionDetail> {
    return this.request(`/api/revisions/${encodeURIComponent(name)}`);
  }

  startDraft(
    kind: 'taskSops' | 'requirements',
    name: string,
    expectedEtag: string,
  ): Promise<ResourceMutationResult> {
    return this.request(`/api/resources/${kind}/${encodeURIComponent(name)}/drafts`, {
      method: 'POST', body: { expectedEtag },
    });
  }

  discardDraft(
    kind: 'taskSops' | 'requirements',
    name: string,
    expectedEtag: string,
  ): Promise<ResourceMutationResult> {
    return this.request(`/api/resources/${kind}/${encodeURIComponent(name)}/drafts`, {
      method: 'DELETE', body: { expectedEtag },
    });
  }

  reviewProposal(
    kind: 'taskSops' | 'requirements',
    name: string,
    expectedEtag: string,
  ): Promise<DependencyReviewProposal> {
    return this.request(`/api/resources/${kind}/${encodeURIComponent(name)}/review-proposal`, {
      method: 'POST', body: { expectedEtag },
    });
  }

  acknowledgeReview(
    kind: 'taskSops' | 'requirements',
    name: string,
    expectedEtag: string,
    proposalDigest: string,
  ): Promise<ResourceMutationResult | DependencyReviewProposal> {
    return this.request<ResourceMutationResult>(`/api/resources/${kind}/${encodeURIComponent(name)}/review-acknowledgements`, {
      method: 'POST', body: { expectedEtag, proposalDigest },
    }).catch((error) => this.dependencyProposal(error));
  }

  confirm(
    kind: 'taskSops' | 'requirements',
    name: string,
    expectedEtag: string,
  ): Promise<ConfirmationResult | DependencyReviewProposal> {
    return this.request<ConfirmationResult>(`/api/resources/${kind}/${encodeURIComponent(name)}/confirmations`, {
      method: 'POST', body: { expectedEtag },
    }).catch((error) => this.dependencyProposal(error));
  }

  initializeAttachment(
    kind: AttachmentOwnerResourceKind,
    ownerName: string,
    input: AttachmentUploadInput,
  ): Promise<AttachmentUploadSession> {
    return this.request(this.attachmentBase(kind, ownerName), { method: 'POST', body: input });
  }

  uploadAttachmentPart(
    kind: AttachmentOwnerResourceKind,
    ownerName: string,
    uid: string,
    partNumber: number,
    body: Blob,
  ): Promise<AttachmentPartReceipt> {
    return this.requestBinary(
      `${this.attachmentBase(kind, ownerName)}/${encodeURIComponent(uid)}/parts/${partNumber}`,
      body,
    );
  }

  completeAttachment(
    kind: AttachmentOwnerResourceKind,
    ownerName: string,
    uid: string,
  ): Promise<AttachmentMetadata> {
    return this.request(`${this.attachmentBase(kind, ownerName)}/${encodeURIComponent(uid)}/complete`, {
      method: 'POST',
    });
  }

  abortAttachment(kind: AttachmentOwnerResourceKind, ownerName: string, uid: string): Promise<void> {
    return this.request(`${this.attachmentBase(kind, ownerName)}/${encodeURIComponent(uid)}/abort`, {
      method: 'POST',
    });
  }

  getAttachment(kind: AttachmentOwnerResourceKind, ownerName: string, uid: string): Promise<AttachmentMetadata> {
    return this.request(`${this.attachmentBase(kind, ownerName)}/${encodeURIComponent(uid)}`);
  }

  unlinkAttachment(kind: AttachmentOwnerResourceKind, ownerName: string, uid: string): Promise<void> {
    return this.request(`${this.attachmentBase(kind, ownerName)}/${encodeURIComponent(uid)}`, {
      method: 'DELETE',
    });
  }

  exportRevision(name: string, format: 'yaml' | 'pdf'): Promise<Response> {
    return this.requestFetch(`${this.baseUrl}/api/revisions/${encodeURIComponent(name)}/export.${format}`, {
      headers: this.authHeaders(),
    }).then((response) => {
      if (!response.ok) return this.throwResponseError(response);
      return response;
    });
  }

  async request<T>(path: string, options: {
    method?: string;
    body?: unknown;
    authenticated?: boolean;
    signal?: AbortSignal;
  } = {}): Promise<T> {
    const headers = options.authenticated === false ? new Headers() : this.authHeaders();
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

  private async requestBinary<T>(path: string, body: Blob): Promise<T> {
    const headers = this.authHeaders();
    headers.set('content-type', 'application/octet-stream');
    const response = await this.requestFetch(`${this.baseUrl}${path}`, { method: 'PUT', headers, body });
    const contentType = response.headers.get('content-type') ?? '';
    const value = contentType.includes('application/json') ? await response.json() : undefined;
    if (!response.ok) throw new ApiClientError(response.status, isApiErrorBody(value) ? value : undefined);
    return value as T;
  }

  private attachmentBase(kind: AttachmentOwnerResourceKind, ownerName: string): string {
    return `/api/resources/${kind}/${encodeURIComponent(ownerName)}/attachments`;
  }

  private authHeaders(): Headers {
    const headers = new Headers();
    const password = this.getPassword();
    if (password) headers.set('authorization', `Bearer ${password}`);
    return headers;
  }

  private async throwResponseError(response: Response): Promise<never> {
    const contentType = response.headers.get('content-type') ?? '';
    const value = contentType.includes('application/json') ? await response.json() : undefined;
    throw new ApiClientError(response.status, isApiErrorBody(value) ? value : undefined);
  }

  private dependencyProposal(error: unknown): DependencyReviewProposal {
    if (error instanceof ApiClientError && error.body?.error.kind === 'DEPENDENCY_CHANGED') {
      const value = error.body.error.details?.dependencyDiff;
      if (value && typeof value === 'object' &&
        typeof (value as { proposalDigest?: unknown }).proposalDigest === 'string' &&
        typeof (value as { rootEtag?: unknown }).rootEtag === 'string') {
        return value as DependencyReviewProposal;
      }
    }
    throw error;
  }
}
