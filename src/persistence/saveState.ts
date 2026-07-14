import type { SaveWarning } from '../../shared/transport/resourceDto';

export type { SaveWarning } from '../../shared/transport/resourceDto';

export type QueueFailure<T> =
  | { kind: 'retryable'; message: string; unknownOutcome?: boolean }
  | { kind: 'terminal'; message: string; code?: string }
  | { kind: 'conflict'; message: string; serverValue: T; serverEtag: string };

export type ResourceSaveState<T> =
  | { kind: 'ready'; etag: string; warning?: SaveWarning }
  | { kind: 'saving'; etag: string; warning?: SaveWarning }
  | { kind: 'paused-retryable'; etag: string; message: string; unknownOutcome: boolean; warning?: SaveWarning }
  | { kind: 'paused-terminal'; etag: string; message: string; code?: string; warning?: SaveWarning }
  | {
    kind: 'paused-conflict';
    etag: string;
    message: string;
    serverValue: T;
    serverEtag: string;
    warning?: SaveWarning;
  };

export type SaveSuccess = { etag: string; warning?: SaveWarning };
