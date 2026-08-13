import type { QueueFailure, SaveWarning } from './saveState';
import {
  diffDraftValues,
  type DurableTaskSopDraft,
  type TaskSopDraftStore,
} from './taskSopDraftStore';
import {
  mergeTaskSopDraft,
  setMergedValue,
  type TaskSopMergeConflict,
} from './taskSopThreeWayMerge';

export type TaskSopSyncTransport<T> = {
  save(
    resourceName: string,
    value: T,
    expectedEtag: string,
    mutation: { mutationId: string; editorSessionId: string },
  ): Promise<{ etag: string; warning?: SaveWarning }>;
  read(resourceName: string): Promise<{ value: T; etag: string }>;
};

export type TaskSopConflictState<T> = {
  baseValue: T;
  localValue: T;
  remoteValue: T;
  remoteEtag: string;
  mergedValue: T;
  conflicts: TaskSopMergeConflict[];
};

export type TaskSopSyncState<T> =
  | { kind: 'ready'; etag: string; hasUnsavedChanges: boolean; warning?: SaveWarning }
  | { kind: 'saving'; etag: string; hasUnsavedChanges: true; warning?: SaveWarning }
  | { kind: 'retrying'; etag: string; hasUnsavedChanges: true; retryAt: number; warning?: SaveWarning }
  | { kind: 'terminal'; etag: string; hasUnsavedChanges: true; message: string; code?: string; warning?: SaveWarning }
  | { kind: 'blocked'; etag: string; hasUnsavedChanges: true; message: string; warning?: SaveWarning }
  | { kind: 'conflict'; etag: string; hasUnsavedChanges: true; conflict: TaskSopConflictState<T>; warning?: SaveWarning };

export type TaskSopSyncEngineOptions<T> = {
  resourceName: string;
  initial: { value: T; etag: string };
  store: TaskSopDraftStore<T>;
  transport: TaskSopSyncTransport<T>;
  editorSessionId?: string;
  debounceMs?: number;
  random?: () => number;
  onLocalValue?: (value: T) => void;
  onStateChange?: (state: TaskSopSyncState<T>) => void;
};

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isQueueFailure<T>(error: unknown): error is QueueFailure<T> {
  return Boolean(error && typeof error === 'object' && ['retryable', 'terminal', 'conflict'].includes(
    (error as { kind?: string }).kind ?? '',
  ));
}

export class TaskSopSyncEngine<T> {
  readonly resourceName: string;
  private readonly store: TaskSopDraftStore<T>;
  private readonly transport: TaskSopSyncTransport<T>;
  private readonly debounceMs: number;
  private readonly random: () => number;
  private readonly onLocalValue?: (value: T) => void;
  private readonly onStateChange?: (state: TaskSopSyncState<T>) => void;
  private readonly editorSessionId: string;
  private draft: DurableTaskSopDraft<T>;
  private durable = true;
  private flushing = false;
  private retryCount = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private warning?: SaveWarning;
  private current: TaskSopSyncState<T>;
  private conflict?: TaskSopConflictState<T>;
  private readonly ready: Promise<void>;
  private destroyed = false;
  private readonly coordinatorId = uuid();
  private leader = true;
  private channel?: BroadcastChannel;
  private leaseTimer?: ReturnType<typeof setInterval>;

  constructor(options: TaskSopSyncEngineOptions<T>) {
    this.resourceName = options.resourceName;
    this.store = options.store;
    this.transport = options.transport;
    this.debounceMs = options.debounceMs ?? 600;
    this.random = options.random ?? Math.random;
    this.onLocalValue = options.onLocalValue;
    this.onStateChange = options.onStateChange;
    this.editorSessionId = options.editorSessionId ?? uuid();
    this.draft = {
      resourceName: options.resourceName,
      baseValue: structuredClone(options.initial.value),
      baseEtag: options.initial.etag,
      localValue: structuredClone(options.initial.value),
      journal: [],
      nextSequence: 1,
      editorSessionId: this.editorSessionId,
      updatedAt: new Date().toISOString(),
    };
    this.current = { kind: 'ready', etag: options.initial.etag, hasUnsavedChanges: false };
    this.ready = this.restore(options.initial).then(() => {
      this.startCoordination();
      if (this.hasUnsavedChanges) this.schedule(0);
    });
    if (typeof window !== 'undefined') window.addEventListener('online', this.onOnline);
  }

  get state(): TaskSopSyncState<T> {
    return this.current;
  }

  get localValue(): T {
    return structuredClone(this.draft.localValue);
  }

  get hasUnsavedChanges(): boolean {
    return !equal(this.draft.localValue, this.draft.baseValue) || Boolean(this.draft.pendingMutation);
  }

  async initialized(): Promise<void> {
    await this.ready;
  }

  async submit(value: T, urgency: 'debounced' | 'immediate' = 'debounced'): Promise<boolean> {
    await this.ready;
    const nextValue = structuredClone(value);
    const timestamp = new Date().toISOString();
    const terminalCode = this.current.kind === 'terminal' ? this.current.code : undefined;
    try {
      this.draft = await this.mutateStore((current) => ({
        ...current,
        localValue: nextValue,
        journal: [...current.journal, {
          sequence: current.nextSequence,
          createdAt: timestamp,
          operations: diffDraftValues(current.localValue, nextValue),
        }],
        nextSequence: current.nextSequence + 1,
        pendingMutation: this.current.kind === 'terminal' ? undefined : current.pendingMutation,
        updatedAt: timestamp,
      }));
      this.durable = true;
    } catch {
      this.durable = false;
      this.draft = {
        ...this.draft,
        localValue: nextValue,
        journal: [...this.draft.journal, {
          sequence: this.draft.nextSequence,
          createdAt: timestamp,
          operations: diffDraftValues(this.draft.localValue, nextValue),
        }],
        nextSequence: this.draft.nextSequence + 1,
        pendingMutation: this.current.kind === 'terminal' ? undefined : this.draft.pendingMutation,
        updatedAt: timestamp,
      };
    }
    this.onLocalValue?.(structuredClone(nextValue));
    this.channel?.postMessage({ kind: 'changed', sender: this.coordinatorId });
    this.emit({ kind: 'ready', etag: this.draft.baseEtag, hasUnsavedChanges: true, warning: this.warning });
    if (terminalCode === 'UNAUTHORIZED' || terminalCode === 'HTTP_403') return true;
    if (!this.durable) {
      const saved = await this.flushNow();
      if (!saved && this.current.kind === 'retrying') {
        this.emit({
          kind: 'blocked',
          etag: this.draft.baseEtag,
          hasUnsavedChanges: true,
          message: '暂时无法安全保存新的修改，请保持页面打开；连接恢复后可继续。',
          warning: this.warning,
        });
      }
      return saved;
    }
    this.schedule(urgency === 'immediate' ? 0 : this.debounceMs);
    return true;
  }

  async flushNow(): Promise<boolean> {
    await this.ready;
    if (!this.leader && !this.tryAcquireLeadership()) {
      this.channel?.postMessage({ kind: 'changed', sender: this.coordinatorId });
      return this.waitForLeaderSync();
    }
    this.cancelTimer();
    if (this.flushing || this.conflict || !this.hasUnsavedChanges) return !this.hasUnsavedChanges;
    this.flushing = true;
    let pending = this.draft.pendingMutation;
    if (!pending) {
      pending = {
        mutationId: uuid(),
        sequence: this.draft.nextSequence - 1,
        value: structuredClone(this.draft.localValue),
        expectedEtag: this.draft.baseEtag,
      };
      this.draft = { ...this.draft, pendingMutation: pending, updatedAt: new Date().toISOString() };
      await this.persistBestEffort((current) => ({ ...current, pendingMutation: pending }));
    }
    this.emit({ kind: 'saving', etag: pending.expectedEtag, hasUnsavedChanges: true, warning: this.warning });
    try {
      const result = await this.transport.save(
        this.resourceName,
        structuredClone(pending.value),
        pending.expectedEtag,
        { mutationId: pending.mutationId, editorSessionId: this.editorSessionId },
      );
      this.warning = result.warning ?? this.warning;
      const acknowledged = pending;
      this.draft = {
        ...this.draft,
        baseValue: structuredClone(acknowledged.value),
        baseEtag: result.etag,
        journal: this.draft.journal.filter((entry) => entry.sequence > acknowledged.sequence),
        pendingMutation: undefined,
        updatedAt: new Date().toISOString(),
      };
      await this.persistBestEffort((current) => ({
        ...current,
        baseValue: structuredClone(acknowledged.value),
        baseEtag: result.etag,
        journal: current.journal.filter((entry) => entry.sequence > acknowledged.sequence),
        pendingMutation: undefined,
        updatedAt: new Date().toISOString(),
      }));
      this.retryCount = 0;
      this.flushing = false;
      this.channel?.postMessage({ kind: 'synced', sender: this.coordinatorId });
      if (this.hasUnsavedChanges) {
        this.emit({ kind: 'ready', etag: result.etag, hasUnsavedChanges: true, warning: this.warning });
        this.schedule(0);
      } else {
        this.emit({ kind: 'ready', etag: result.etag, hasUnsavedChanges: false, warning: this.warning });
      }
      return true;
    } catch (error) {
      this.flushing = false;
      if (isQueueFailure<T>(error) && error.kind === 'conflict') {
        await this.handleConflict(error.serverValue, error.serverEtag);
        return false;
      }
      if (isQueueFailure<T>(error) && error.kind === 'terminal') {
        this.emit({
          kind: 'terminal', etag: pending.expectedEtag, hasUnsavedChanges: true,
          message: error.message, code: error.code, warning: this.warning,
        });
        return false;
      }
      const delay = this.retryDelay();
      this.emit({
        kind: 'retrying', etag: pending.expectedEtag, hasUnsavedChanges: true,
        retryAt: Date.now() + delay, warning: this.warning,
      });
      this.schedule(delay);
      return false;
    }
  }

  async resolveConflict(resolutions: Map<string, unknown>): Promise<void> {
    await this.ready;
    if (!this.conflict) return;
    let resolved = structuredClone(this.conflict.mergedValue);
    for (const conflict of this.conflict.conflicts) {
      const key = JSON.stringify(conflict.path);
      if (!resolutions.has(key)) throw new Error(`Conflict is unresolved: ${key}`);
      resolved = setMergedValue(resolved, conflict.path, resolutions.get(key));
    }
    const remote = this.conflict.remoteValue;
    const remoteEtag = this.conflict.remoteEtag;
    this.conflict = undefined;
    this.draft = {
      ...this.draft,
      baseValue: structuredClone(remote),
      baseEtag: remoteEtag,
      localValue: structuredClone(resolved),
      journal: [{
        sequence: this.draft.nextSequence,
        createdAt: new Date().toISOString(),
        operations: diffDraftValues(remote, resolved),
      }],
      nextSequence: this.draft.nextSequence + 1,
      pendingMutation: undefined,
      updatedAt: new Date().toISOString(),
    };
    await this.persistBestEffort(() => this.draft);
    this.onLocalValue?.(structuredClone(resolved));
    this.emit({ kind: 'ready', etag: remoteEtag, hasUnsavedChanges: true, warning: this.warning });
    this.schedule(0);
  }

  destroy(): void {
    this.destroyed = true;
    this.cancelTimer();
    if (this.leaseTimer !== undefined) clearInterval(this.leaseTimer);
    this.channel?.close();
    this.releaseLeadership();
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline);
  }

  private async restore(initial: { value: T; etag: string }): Promise<void> {
    try {
      let stored = await this.store.initialize({
        resourceName: this.resourceName,
        baseValue: structuredClone(initial.value),
        baseEtag: initial.etag,
        localValue: structuredClone(initial.value),
        editorSessionId: this.editorSessionId,
      });
      if (stored.journal.length === 0 && !stored.pendingMutation && !equal(stored.baseValue, initial.value)) {
        stored = await this.store.mutate(this.resourceName, (current) => ({
          ...current,
          baseValue: structuredClone(initial.value),
          baseEtag: initial.etag,
          localValue: structuredClone(initial.value),
          updatedAt: new Date().toISOString(),
        }));
      }
      this.draft = stored;
      this.durable = true;
    } catch {
      this.durable = false;
    }
    if (this.hasUnsavedChanges) {
      this.onLocalValue?.(structuredClone(this.draft.localValue));
      this.emit({ kind: 'ready', etag: this.draft.baseEtag, hasUnsavedChanges: true, warning: this.warning });
    } else {
      this.emit({ kind: 'ready', etag: this.draft.baseEtag, hasUnsavedChanges: false, warning: this.warning });
    }
  }

  private async handleConflict(remoteValue: T, remoteEtag: string): Promise<void> {
    const merged = mergeTaskSopDraft(this.draft.baseValue, this.draft.localValue, remoteValue);
    if (merged.conflicts.length === 0) {
      this.draft = {
        ...this.draft,
        baseValue: structuredClone(remoteValue),
        baseEtag: remoteEtag,
        localValue: structuredClone(merged.value),
        pendingMutation: undefined,
        journal: [{
          sequence: this.draft.nextSequence,
          createdAt: new Date().toISOString(),
          operations: diffDraftValues(remoteValue, merged.value),
        }],
        nextSequence: this.draft.nextSequence + 1,
      };
      await this.persistBestEffort(() => this.draft);
      this.onLocalValue?.(structuredClone(merged.value));
      this.schedule(0);
      return;
    }
    this.conflict = {
      baseValue: structuredClone(this.draft.baseValue),
      localValue: structuredClone(this.draft.localValue),
      remoteValue: structuredClone(remoteValue),
      remoteEtag,
      mergedValue: structuredClone(merged.value),
      conflicts: merged.conflicts,
    };
    this.draft = { ...this.draft, pendingMutation: undefined };
    await this.persistBestEffort((current) => ({ ...current, pendingMutation: undefined }));
    this.emit({ kind: 'conflict', etag: this.draft.baseEtag, hasUnsavedChanges: true, conflict: this.conflict, warning: this.warning });
  }

  private retryDelay(): number {
    const base = Math.min(30_000, 1_000 * 2 ** this.retryCount);
    this.retryCount += 1;
    return Math.round(base * (0.8 + this.random() * 0.4));
  }

  private schedule(delay: number): void {
    if (this.destroyed || this.conflict || this.current.kind === 'terminal') return;
    if (!this.leader) {
      this.channel?.postMessage({ kind: 'changed', sender: this.coordinatorId });
      return;
    }
    this.cancelTimer();
    this.timer = setTimeout(() => void this.flushNow(), delay);
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async persistBestEffort(
    update: (current: DurableTaskSopDraft<T>) => DurableTaskSopDraft<T>,
  ): Promise<void> {
    try {
      this.draft = await this.mutateStore(update);
      this.durable = true;
    } catch {
      this.durable = false;
    }
  }

  private async mutateStore(
    update: (current: DurableTaskSopDraft<T>) => DurableTaskSopDraft<T>,
  ): Promise<DurableTaskSopDraft<T>> {
    try {
      return await this.store.mutate(this.resourceName, update);
    } catch (error) {
      if (this.durable) throw error;
      await this.store.initialize({
        resourceName: this.resourceName,
        baseValue: structuredClone(this.draft.baseValue),
        baseEtag: this.draft.baseEtag,
        localValue: structuredClone(this.draft.localValue),
        editorSessionId: this.editorSessionId,
      });
      return this.store.mutate(this.resourceName, update);
    }
  }

  private emit(state: TaskSopSyncState<T>): void {
    this.current = state;
    this.onStateChange?.(state);
  }

  private readonly onOnline = () => {
    if (this.current.kind === 'retrying' || this.current.kind === 'blocked') {
      this.retryCount = 0;
      this.schedule(0);
    }
  };

  private startCoordination(): void {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
    this.tryAcquireLeadership();
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(`sop-task-sync:${this.resourceName}`);
      this.channel.onmessage = (event: MessageEvent<{ kind?: string; sender?: string }>) => {
        if (event.data?.sender === this.coordinatorId) return;
        if (event.data?.kind === 'changed' && this.leader) void this.reloadSharedDraft(true);
        if (event.data?.kind === 'synced' && !this.leader) void this.reloadSharedDraft(false);
      };
    }
    this.leaseTimer = setInterval(() => {
      const wasLeader = this.leader;
      this.tryAcquireLeadership();
      if (!wasLeader && this.leader) void this.reloadSharedDraft(true);
    }, 2_000);
  }

  private leaseKey(): string {
    return `sop-task-sync-lease:${this.resourceName}`;
  }

  private tryAcquireLeadership(): boolean {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
      this.leader = true;
      return true;
    }
    try {
      const now = Date.now();
      const raw = localStorage.getItem(this.leaseKey());
      const current = raw ? JSON.parse(raw) as { owner?: string; expiresAt?: number } : undefined;
      if (current?.owner && current.owner !== this.coordinatorId && (current.expiresAt ?? 0) > now) {
        this.leader = false;
        return false;
      }
      localStorage.setItem(this.leaseKey(), JSON.stringify({ owner: this.coordinatorId, expiresAt: now + 5_000 }));
      const confirmed = JSON.parse(localStorage.getItem(this.leaseKey()) ?? '{}') as { owner?: string };
      this.leader = confirmed.owner === this.coordinatorId;
      return this.leader;
    } catch {
      // Storage coordination is an optimization. IndexedDB still preserves the
      // draft and ETag conflict handling remains the correctness boundary.
      this.leader = true;
      return true;
    }
  }

  private releaseLeadership(): void {
    if (!this.leader || typeof window === 'undefined' || typeof localStorage === 'undefined') return;
    try {
      const current = JSON.parse(localStorage.getItem(this.leaseKey()) ?? '{}') as { owner?: string };
      if (current.owner === this.coordinatorId) localStorage.removeItem(this.leaseKey());
    } catch {
      // Nothing to release when browser storage is unavailable.
    }
  }

  private async reloadSharedDraft(flush: boolean): Promise<void> {
    try {
      const stored = await this.store.load(this.resourceName);
      if (!stored) return;
      this.draft = stored;
      this.onLocalValue?.(structuredClone(stored.localValue));
      if (flush && this.hasUnsavedChanges) this.schedule(0);
      if (!this.hasUnsavedChanges) {
        this.emit({ kind: 'ready', etag: stored.baseEtag, hasUnsavedChanges: false, warning: this.warning });
      }
    } catch {
      // The active tab keeps its in-memory copy and normal retry behavior.
    }
  }

  private async waitForLeaderSync(): Promise<boolean> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const stored = await this.store.load(this.resourceName).catch(() => undefined);
      if (stored) this.draft = stored;
      if (!this.hasUnsavedChanges) return true;
      if (this.tryAcquireLeadership()) return this.flushNow();
    }
    return false;
  }
}
