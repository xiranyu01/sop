import type { ResourceKind } from '../../shared/transport/resourceDto';
import { ResourceSaveQueue, type ResourceSaveQueueOptions } from './resourceSaveQueue';
import type { ResourceSaveState } from './saveState';

export type RegisteredQueueState = {
  kind: ResourceKind;
  resourceName: string;
  state: ResourceSaveState<unknown>;
  hasUnsavedChanges: boolean;
};

export type QueueRegistryListener = (states: RegisteredQueueState[]) => void;

type Entry = {
  kind: ResourceKind;
  queue: ResourceSaveQueue<unknown>;
};

/** Owns exactly one independent autosave queue per mutable resource name. */
export class ResourceSaveQueueRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<QueueRegistryListener>();

  get hasUnsavedChanges(): boolean {
    return [...this.entries.values()].some(({ queue }) => queue.hasUnsavedChanges);
  }

  get states(): RegisteredQueueState[] {
    return [...this.entries.entries()].map(([resourceName, entry]) => ({
      kind: entry.kind,
      resourceName,
      state: entry.queue.state,
      hasUnsavedChanges: entry.queue.hasUnsavedChanges,
    }));
  }

  get<T>(resourceName: string): ResourceSaveQueue<T> | undefined {
    return this.entries.get(resourceName)?.queue as ResourceSaveQueue<T> | undefined;
  }

  register<T>(
    kind: ResourceKind,
    options: Omit<ResourceSaveQueueOptions<T>, 'onStateChange'>,
  ): ResourceSaveQueue<T> {
    const existing = this.entries.get(options.resourceName);
    if (existing) {
      if (existing.kind !== kind) {
        throw new Error(`Queue ${options.resourceName} is already registered as ${existing.kind}`);
      }
      return existing.queue as ResourceSaveQueue<T>;
    }
    const queue = new ResourceSaveQueue({
      ...options,
      onStateChange: () => this.emit(),
    });
    this.entries.set(options.resourceName, { kind, queue: queue as ResourceSaveQueue<unknown> });
    this.emit();
    return queue;
  }

  remove(resourceName: string): boolean {
    const entry = this.entries.get(resourceName);
    if (!entry || entry.queue.hasUnsavedChanges) return false;
    const removed = this.entries.delete(resourceName);
    if (removed) this.emit();
    return removed;
  }

  /** Clears editor queues only after the caller explicitly accepts discarding local edits. */
  clear(confirmDiscard = false): boolean {
    if (this.hasUnsavedChanges && !confirmDiscard) return false;
    if (this.entries.size === 0) return true;
    this.entries.clear();
    this.emit();
    return true;
  }

  subscribe(listener: QueueRegistryListener): () => void {
    this.listeners.add(listener);
    listener(this.states);
    return () => this.listeners.delete(listener);
  }

  installNavigationWarning(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!this.hasUnsavedChanges) return;
      event.preventDefault();
      event.returnValue = '';
    };
    target.addEventListener('beforeunload', onBeforeUnload);
    return () => target.removeEventListener('beforeunload', onBeforeUnload);
  }

  private emit(): void {
    const states = this.states;
    for (const listener of this.listeners) listener(states);
  }
}
