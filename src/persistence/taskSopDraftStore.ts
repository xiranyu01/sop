export type DraftPatchOperation = {
  op: 'set' | 'delete';
  path: Array<string | number>;
  value?: unknown;
};

export type DraftJournalEntry = {
  sequence: number;
  createdAt: string;
  operations: DraftPatchOperation[];
};

export type PendingTaskSopMutation<T> = {
  mutationId: string;
  sequence: number;
  value: T;
  expectedEtag: string;
};

export type DurableTaskSopDraft<T> = {
  resourceName: string;
  baseValue: T;
  baseEtag: string;
  localValue: T;
  journal: DraftJournalEntry[];
  nextSequence: number;
  editorSessionId: string;
  pendingMutation?: PendingTaskSopMutation<T>;
  updatedAt: string;
};

export type InitialTaskSopDraft<T> = Pick<DurableTaskSopDraft<T>,
  'resourceName' | 'baseValue' | 'baseEtag' | 'localValue' | 'editorSessionId'>;

export interface TaskSopDraftStore<T> {
  load(resourceName: string): Promise<DurableTaskSopDraft<T> | undefined>;
  initialize(initial: InitialTaskSopDraft<T>): Promise<DurableTaskSopDraft<T>>;
  mutate(
    resourceName: string,
    update: (current: DurableTaskSopDraft<T>) => DurableTaskSopDraft<T>,
  ): Promise<DurableTaskSopDraft<T>>;
  remove(resourceName: string): Promise<void>;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

export class IndexedDbTaskSopDraftStore<T> implements TaskSopDraftStore<T> {
  private database?: Promise<IDBDatabase>;

  constructor(private readonly databaseName = 'sop-task-drafts-v1') {}

  async load(resourceName: string): Promise<DurableTaskSopDraft<T> | undefined> {
    const database = await this.open();
    const transaction = database.transaction('drafts', 'readonly');
    const value = await requestResult(transaction.objectStore('drafts').get(resourceName));
    await transactionDone(transaction);
    return value as DurableTaskSopDraft<T> | undefined;
  }

  async initialize(initial: InitialTaskSopDraft<T>): Promise<DurableTaskSopDraft<T>> {
    const existing = await this.load(initial.resourceName);
    if (existing) return existing;
    const value: DurableTaskSopDraft<T> = {
      ...initial,
      journal: [],
      nextSequence: 1,
      updatedAt: new Date().toISOString(),
    };
    const database = await this.open();
    const transaction = database.transaction('drafts', 'readwrite');
    transaction.objectStore('drafts').add(value);
    try {
      await transactionDone(transaction);
      return value;
    } catch (error) {
      const raced = await this.load(initial.resourceName);
      if (raced) return raced;
      throw error;
    }
  }

  async mutate(
    resourceName: string,
    update: (current: DurableTaskSopDraft<T>) => DurableTaskSopDraft<T>,
  ): Promise<DurableTaskSopDraft<T>> {
    const database = await this.open();
    const transaction = database.transaction('drafts', 'readwrite');
    const store = transaction.objectStore('drafts');
    const current = await requestResult(store.get(resourceName)) as DurableTaskSopDraft<T> | undefined;
    if (!current) {
      transaction.abort();
      throw new Error(`Durable TaskSop draft is not initialized: ${resourceName}`);
    }
    const next = update(current);
    store.put(next);
    await transactionDone(transaction);
    return next;
  }

  async remove(resourceName: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction('drafts', 'readwrite');
    transaction.objectStore('drafts').delete(resourceName);
    await transactionDone(transaction);
  }

  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is unavailable'));
      const opening = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(this.databaseName, 1);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('drafts')) {
            database.createObjectStore('drafts', { keyPath: 'resourceName' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Unable to open IndexedDB'));
        request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked'));
      });
      this.database = opening.catch((error) => {
        this.database = undefined;
        throw error;
      });
    }
    return this.database;
  }
}

export class MemoryTaskSopDraftStore<T> implements TaskSopDraftStore<T> {
  private readonly values = new Map<string, DurableTaskSopDraft<T>>();

  async load(resourceName: string): Promise<DurableTaskSopDraft<T> | undefined> {
    return this.values.get(resourceName);
  }

  async initialize(initial: InitialTaskSopDraft<T>): Promise<DurableTaskSopDraft<T>> {
    const current = this.values.get(initial.resourceName);
    if (current) return current;
    const value: DurableTaskSopDraft<T> = {
      ...initial,
      journal: [],
      nextSequence: 1,
      updatedAt: new Date().toISOString(),
    };
    this.values.set(initial.resourceName, value);
    return value;
  }

  async mutate(
    resourceName: string,
    update: (current: DurableTaskSopDraft<T>) => DurableTaskSopDraft<T>,
  ): Promise<DurableTaskSopDraft<T>> {
    const current = this.values.get(resourceName);
    if (!current) throw new Error(`Durable TaskSop draft is not initialized: ${resourceName}`);
    const next = update(current);
    this.values.set(resourceName, next);
    return next;
  }

  async remove(resourceName: string): Promise<void> {
    this.values.delete(resourceName);
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function diffDraftValues(
  before: unknown,
  after: unknown,
  path: Array<string | number> = [],
): DraftPatchOperation[] {
  if (same(before, after)) return [];
  if (
    before && after && typeof before === 'object' && typeof after === 'object'
    && !Array.isArray(before) && !Array.isArray(after)
  ) {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) => {
      if (!(key in right)) return [{ op: 'delete' as const, path: [...path, key] }];
      if (!(key in left)) return [{ op: 'set' as const, path: [...path, key], value: right[key] }];
      return diffDraftValues(left[key], right[key], [...path, key]);
    });
  }
  return [{ op: 'set', path, value: after }];
}
