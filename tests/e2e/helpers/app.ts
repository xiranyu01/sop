import { expect, type APIRequestContext, type Page } from '@playwright/test';

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
