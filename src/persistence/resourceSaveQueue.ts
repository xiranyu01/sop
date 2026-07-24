import type { QueueFailure, ResourceSaveState, SaveSuccess, SaveWarning } from './saveState';

export type ResourceValue<T> = { value: T; etag: string };

export type ResourceSaveTransport<T> = {
  save(resourceName: string, value: T, expectedEtag: string): Promise<SaveSuccess>;
  read(resourceName: string): Promise<ResourceValue<T>>;
};

export type ResourceSaveQueueOptions<T> = {
  resourceName: string;
  initial: ResourceValue<T>;
  transport: ResourceSaveTransport<T>;
  equals?: (left: T, right: T) => boolean;
  onStateChange?: (state: ResourceSaveState<T>) => void;
};

function defaultEquals<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isQueueFailure<T>(error: unknown): error is QueueFailure<T> {
  return Boolean(error && typeof error === 'object' &&
    ['retryable', 'terminal', 'conflict'].includes((error as { kind?: string }).kind ?? ''));
}

/**
 * Serializes writes for one mutable canonical resource.
 *
 * submit() coalesces pending edits to the newest value. Failures never retry
 * automatically and never discard local state. A queue instance must never be
 * shared by different resource names.
 */
export class ResourceSaveQueue<T> {
  readonly resourceName: string;
  private readonly transport: ResourceSaveTransport<T>;
  private readonly equals: (left: T, right: T) => boolean;
  private readonly onStateChange?: (state: ResourceSaveState<T>) => void;
  private acknowledged: ResourceValue<T>;
  private local: T;
  private pending?: T;
  private inFlight?: T;
  private unknownOutcomeRecovery?: { sentValue: T; sentEtag: string };
  private warning?: SaveWarning;
  private current: ResourceSaveState<T>;
  private readonly settleWaiters: Array<(state: ResourceSaveState<T>) => void> = [];

  constructor(options: ResourceSaveQueueOptions<T>) {
    this.resourceName = options.resourceName;
    this.transport = options.transport;
    this.equals = options.equals ?? defaultEquals;
    this.onStateChange = options.onStateChange;
    this.acknowledged = structuredClone(options.initial);
    this.local = structuredClone(options.initial.value);
    this.current = { kind: 'ready', etag: options.initial.etag };
  }

  get state(): ResourceSaveState<T> {
    return this.current;
  }

  get localValue(): T {
    return structuredClone(this.local);
  }

  get hasUnsavedChanges(): boolean {
    return !this.equals(this.local, this.acknowledged.value);
  }

  dismissWarning(): void {
    this.warning = undefined;
    this.setState({ ...this.current, warning: undefined });
  }

  /** Revert a server-rejected edit after the caller explicitly accepts discarding it. */
  discardTerminalChanges(confirmDiscard: boolean): boolean {
    if (!confirmDiscard || this.current.kind !== 'paused-terminal') return false;
    this.local = structuredClone(this.acknowledged.value);
    this.pending = undefined;
    this.unknownOutcomeRecovery = undefined;
    this.setState({ kind: 'ready', etag: this.acknowledged.etag, warning: this.warning });
    return true;
  }

  submit(value: T): Promise<ResourceSaveState<T>> {
    this.local = structuredClone(value);
    this.pending = structuredClone(value);
    if (this.isPaused()) {
      // The visible state name is unchanged, but subscribers still need to
      // learn that the retained local value (and navigation risk) changed.
      this.setState({ ...this.current });
      return Promise.resolve(this.current);
    }
    void this.pump();
    return this.whenSettled();
  }

  whenSettled(): Promise<ResourceSaveState<T>> {
    if (this.isSettled()) return Promise.resolve(this.current);
    return new Promise((resolve) => this.settleWaiters.push(resolve));
  }

  async retry(): Promise<void> {
    if (this.current.kind !== 'paused-retryable' && this.current.kind !== 'paused-terminal') return;
    if (this.current.kind === 'paused-retryable' && this.current.unknownOutcome) {
      const recovery = this.unknownOutcomeRecovery;
      const server = await this.transport.read(this.resourceName);
      this.unknownOutcomeRecovery = undefined;
      if (recovery && this.equals(server.value, recovery.sentValue)) {
        this.acknowledged = structuredClone(server);
        if (this.equals(server.value, this.local)) {
          this.pending = undefined;
          this.setState({ kind: 'ready', etag: server.etag, warning: this.warning });
          return;
        }
        this.pending = structuredClone(this.local);
        this.setState({ kind: 'ready', etag: server.etag, warning: this.warning });
        await this.pump();
        return;
      }
      if (this.equals(server.value, this.local)) {
        this.acknowledged = structuredClone(server);
        this.pending = undefined;
        this.setState({ kind: 'ready', etag: server.etag, warning: this.warning });
        return;
      }
      if (server.etag === (recovery?.sentEtag ?? this.acknowledged.etag)) {
        this.acknowledged = structuredClone(server);
        this.pending = structuredClone(this.local);
        this.setState({ kind: 'ready', etag: server.etag, warning: this.warning });
        await this.pump();
        return;
      }
      this.setState({
        kind: 'paused-conflict',
        etag: this.acknowledged.etag,
        message: '服务器内容已在结果未知期间发生变化',
        serverValue: structuredClone(server.value),
        serverEtag: server.etag,
        warning: this.warning,
      });
      return;
    }
    this.unknownOutcomeRecovery = undefined;
    this.pending = structuredClone(this.local);
    this.setState({ kind: 'ready', etag: this.acknowledged.etag, warning: this.warning });
    await this.pump();
  }

  /** Replace local content with the exact server value after explicit UI confirmation. */
  reloadServer(confirmReplacement: boolean): void {
    if (!confirmReplacement || this.current.kind !== 'paused-conflict') return;
    this.local = structuredClone(this.current.serverValue);
    this.acknowledged = { value: structuredClone(this.current.serverValue), etag: this.current.serverEtag };
    this.pending = undefined;
    this.unknownOutcomeRecovery = undefined;
    this.setState({ kind: 'ready', etag: this.current.serverEtag, warning: this.warning });
  }

  /** Explicitly overwrite the latest server version with the retained local content. */
  async reapplyLocal(): Promise<void> {
    if (this.current.kind !== 'paused-conflict') return;
    const server = await this.transport.read(this.resourceName);
    this.acknowledged = structuredClone(server);
    this.pending = structuredClone(this.local);
    this.unknownOutcomeRecovery = undefined;
    this.setState({ kind: 'ready', etag: server.etag, warning: this.warning });
    await this.pump();
  }

  private isPaused(): boolean {
    return this.current.kind.startsWith('paused-');
  }

  private setState(state: ResourceSaveState<T>): void {
    this.current = state;
    this.onStateChange?.(state);
    if (this.isSettled()) {
      const waiters = this.settleWaiters.splice(0);
      for (const resolve of waiters) resolve(this.current);
    }
  }

  private isSettled(): boolean {
    return this.isPaused() || (this.current.kind !== 'saving' && this.inFlight === undefined && this.pending === undefined);
  }

  private async pump(): Promise<void> {
    if (this.inFlight !== undefined || this.pending === undefined || this.isPaused()) return;
    const value = this.pending;
    this.pending = undefined;
    this.inFlight = value;
    const sentEtag = this.acknowledged.etag;
    this.setState({ kind: 'saving', etag: sentEtag, warning: this.warning });
    try {
      const result = await this.transport.save(this.resourceName, structuredClone(value), sentEtag);
      this.warning = result.warning ?? this.warning;
      this.acknowledged = { value: structuredClone(value), etag: result.etag };
      this.unknownOutcomeRecovery = undefined;
      this.inFlight = undefined;
      if (this.pending === undefined && this.equals(this.local, value)) {
        this.setState({ kind: 'ready', etag: result.etag, warning: this.warning });
        return;
      }
      if (this.pending === undefined) this.pending = structuredClone(this.local);
      this.setState({ kind: 'ready', etag: result.etag, warning: this.warning });
      await this.pump();
    } catch (error) {
      this.inFlight = undefined;
      if (!isQueueFailure<T>(error)) {
        this.unknownOutcomeRecovery = { sentValue: structuredClone(value), sentEtag };
        this.setState({
          kind: 'paused-retryable', etag: sentEtag,
          message: error instanceof Error ? error.message : String(error),
          unknownOutcome: true, warning: this.warning,
        });
        return;
      }
      this.unknownOutcomeRecovery = error.kind === 'retryable' && error.unknownOutcome
        ? { sentValue: structuredClone(value), sentEtag }
        : undefined;
      if (error.kind === 'conflict') {
        this.setState({
          kind: 'paused-conflict', etag: sentEtag, message: error.message,
          serverValue: structuredClone(error.serverValue), serverEtag: error.serverEtag, warning: this.warning,
        });
      } else if (error.kind === 'terminal') {
        this.setState({ kind: 'paused-terminal', etag: sentEtag, message: error.message, code: error.code, warning: this.warning });
      } else {
        this.setState({
          kind: 'paused-retryable', etag: sentEtag, message: error.message,
          unknownOutcome: Boolean(error.unknownOutcome), warning: this.warning,
        });
      }
    }
  }
}
