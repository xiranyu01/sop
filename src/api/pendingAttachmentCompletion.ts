import type { AttachmentOwnerResourceKind } from './client';

const storageKey = 'sop:pending-attachment-completions:v1';
const maxPendingCompletions = 20;
const maxAttachmentSizeBytes = 100 * 1024 * 1024;

export type PendingAttachmentCompletion = {
  kind: AttachmentOwnerResourceKind;
  ownerName: string;
  uid: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  lastModified: number;
};

type PendingAttachmentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type FileFingerprint = Pick<File, 'name' | 'type' | 'size' | 'lastModified'>;

function isKind(value: unknown): value is AttachmentOwnerResourceKind {
  return value === 'materials' || value === 'taskSops' || value === 'requirements';
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function parsePending(value: unknown): PendingAttachmentCompletion | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!isKind(item.kind) || !boundedString(item.ownerName, 1024) || !boundedString(item.uid, 128) ||
    !boundedString(item.fileName, 1024) || !boundedString(item.mediaType, 255) ||
    !Number.isSafeInteger(item.sizeBytes) || (item.sizeBytes as number) < 1 ||
    (item.sizeBytes as number) > maxAttachmentSizeBytes || !Number.isSafeInteger(item.lastModified) ||
    (item.lastModified as number) < 0) return undefined;
  return {
    kind: item.kind,
    ownerName: item.ownerName,
    uid: item.uid,
    fileName: item.fileName,
    mediaType: item.mediaType,
    sizeBytes: item.sizeBytes as number,
    lastModified: item.lastModified as number,
  };
}

function readPending(storage: PendingAttachmentStorage): PendingAttachmentCompletion[] {
  const serialized = storage.getItem(storageKey);
  if (!serialized) return [];
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-maxPendingCompletions).map(parsePending)
      .filter((item): item is PendingAttachmentCompletion => Boolean(item));
  } catch {
    return [];
  }
}

function writePending(storage: PendingAttachmentStorage, values: PendingAttachmentCompletion[]): void {
  if (values.length === 0) {
    storage.removeItem(storageKey);
    return;
  }
  storage.setItem(storageKey, JSON.stringify(values.slice(-maxPendingCompletions)));
}

export function findPendingAttachmentCompletion(
  storage: PendingAttachmentStorage,
  kind: AttachmentOwnerResourceKind,
  ownerName: string,
): PendingAttachmentCompletion | undefined {
  return readPending(storage).find((item) => item.kind === kind && item.ownerName === ownerName);
}

export function savePendingAttachmentCompletion(
  storage: PendingAttachmentStorage,
  value: PendingAttachmentCompletion,
): void {
  const normalized = parsePending(value);
  if (!normalized) throw new TypeError('Pending attachment completion is invalid');
  writePending(storage, [
    ...readPending(storage).filter((item) => item.kind !== value.kind || item.ownerName !== value.ownerName),
    normalized,
  ]);
}

export function removePendingAttachmentCompletion(
  storage: PendingAttachmentStorage,
  kind: AttachmentOwnerResourceKind,
  ownerName: string,
  uid: string,
): void {
  writePending(storage, readPending(storage).filter((item) =>
    item.kind !== kind || item.ownerName !== ownerName || item.uid !== uid));
}

export function pendingAttachmentCompletionMatchesFile(
  pending: PendingAttachmentCompletion,
  file: FileFingerprint,
): boolean {
  return pending.fileName === file.name && pending.mediaType === (file.type || 'application/octet-stream') &&
    pending.sizeBytes === file.size && pending.lastModified === file.lastModified;
}
