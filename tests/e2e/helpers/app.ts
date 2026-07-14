import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { JsonValue } from '@bufbuild/protobuf';
import type {
  ResourceDetail,
  ResourceKind,
  ResourceMutationResult,
  ResourcePage,
  ResourceSummary,
  RevisionSummary,
} from '../../../shared/transport/resourceDto';

export const password = 'e2e-password';
export const authHeaders = { Authorization: `Bearer ${password}` };

type PrintedDocument = { title: string; text: string };

export async function installPrintObserver(page: Page) {
  await page.addInitScript(() => {
    type ObservedWindow = Window & { __sopPrintedDocuments?: Array<{ title: string; text: string }> };
    if (window === window.top) {
      const observed = window as ObservedWindow;
      observed.__sopPrintedDocuments = [];
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'sop-e2e-print') observed.__sopPrintedDocuments?.push(event.data.document);
      });
    }
    window.print = () => window.parent.postMessage({
      type: 'sop-e2e-print',
      document: { title: document.title, text: document.body.innerText },
    }, window.location.origin);
  });
}

export async function waitForPrintedDocument(page: Page, expectedText: string): Promise<PrintedDocument> {
  await page.waitForFunction((text) => {
    const observed = window as Window & { __sopPrintedDocuments?: PrintedDocument[] };
    return observed.__sopPrintedDocuments?.some((document) => document.text.includes(text));
  }, expectedText);
  return page.evaluate((text) => {
    const observed = window as Window & { __sopPrintedDocuments?: PrintedDocument[] };
    return observed.__sopPrintedDocuments!.find((document) => document.text.includes(text))!;
  }, expectedText);
}

export async function unlock(page: Page) {
  await page.goto('/');
  await page.getByLabel('访问密码').fill(password);
  await page.getByRole('button', { name: '进入系统' }).click();
  await expect(page.getByRole('heading', { name: '客户需求管理' })).toBeVisible();
}

export async function openAuthenticated(page: Page) {
  await page.addInitScript((value) => window.localStorage.setItem('sop-manager-api-password', value), password);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '客户需求管理' })).toBeVisible();
}

export async function apiJson<T>(request: APIRequestContext, method: string, path: string, data?: unknown): Promise<T> {
  const response = await request.fetch(path, { method, headers: authHeaders, data });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.json() as Promise<T>;
}

export function resourcePath(kind: ResourceKind, name?: string): string {
  return `/api/resources/${kind}${name ? `/${encodeURIComponent(name)}` : ''}`;
}

export async function listResourceSummaries(
  request: APIRequestContext,
  kind: ResourceKind,
): Promise<ResourceSummary[]> {
  const items: ResourceSummary[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ pageSize: '200' });
    if (cursor) query.set('cursor', cursor);
    const page = await apiJson<ResourcePage>(request, 'GET', `${resourcePath(kind)}?${query}`);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

export async function getResource(
  request: APIRequestContext,
  kind: ResourceKind,
  name: string,
): Promise<ResourceDetail> {
  return apiJson<ResourceDetail>(request, 'GET', resourcePath(kind, name));
}

export async function firstResource(
  request: APIRequestContext,
  kind: ResourceKind,
  predicate: (summary: ResourceSummary) => boolean = () => true,
): Promise<ResourceDetail> {
  const summary = (await listResourceSummaries(request, kind)).find(predicate);
  expect(summary, `Expected a ${kind} fixture matching the requested predicate`).toBeDefined();
  return getResource(request, kind, summary!.name);
}

export async function createResource(
  request: APIRequestContext,
  kind: ResourceKind,
  resource: JsonValue,
): Promise<ResourceDetail> {
  const result = await apiJson<ResourceMutationResult>(request, 'POST', resourcePath(kind), { resource });
  return result.resource;
}

export async function updateResource(
  request: APIRequestContext,
  kind: ResourceKind,
  current: ResourceDetail,
  resource: JsonValue,
): Promise<ResourceDetail> {
  const result = await apiJson<ResourceMutationResult>(request, 'PUT', resourcePath(kind, current.name), {
    expectedEtag: current.etag,
    resource,
  });
  return result.resource;
}

export async function listRevisions(
  request: APIRequestContext,
  kind: 'robotModels' | 'taskSops' | 'requirements',
  name: string,
): Promise<RevisionSummary[]> {
  const items: RevisionSummary[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ pageSize: '200' });
    if (cursor) query.set('cursor', cursor);
    const page = await apiJson<{ items: RevisionSummary[]; nextCursor?: string }>(
      request,
      'GET',
      `${resourcePath(kind, name)}/revisions?${query}`,
    );
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

/** Removes server-owned identity and lifecycle output fields from a ProtoJSON root before POST. */
export function cloneResourceForCreate(
  source: JsonValue,
  overrides: Record<string, unknown>,
): JsonValue {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TypeError('Resource template must be an object');
  const clone = structuredClone(source) as Record<string, unknown>;
  for (const field of [
    'name', 'uid', 'etag', 'currentRevision', 'current_revision', 'createTime', 'create_time', 'updateTime', 'update_time',
    'candidateVersionSequence', 'candidate_version_sequence', 'candidateVersionLabel', 'candidate_version_label',
    'candidateSourceVersionId', 'candidate_source_version_id', 'reviewedDependencyDigest', 'reviewed_dependency_digest',
  ]) delete clone[field];
  return { ...clone, ...overrides } as JsonValue;
}
