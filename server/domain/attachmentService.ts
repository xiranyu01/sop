import type {
  AttachmentCleanupIntent,
  AttachmentUploadState,
  CanonicalSnapshot,
} from './appStore';
import { activeManagedStorageKeys, referencedManagedStorageKeys } from './attachmentReachability';
import { CanonicalDataError } from './errors';

export type NewAttachmentUpload = Omit<AttachmentUploadState, 'parts' | 'createdAt' | 'expiresAt'>;

export function cleanupIntentId(operation: AttachmentCleanupIntent['operation'], storageKey: string, uploadId?: string): string {
  return `${operation}:${storageKey}:${uploadId ?? ''}`;
}

export function upsertCleanupIntent(
  snapshot: CanonicalSnapshot,
  input: Omit<AttachmentCleanupIntent, 'id' | 'state' | 'attempts'>,
): void {
  const id = cleanupIntentId(input.operation, input.storageKey, input.uploadId);
  const existing = snapshot.operational.cleanupIntents.find((intent) => intent.id === id);
  if (existing) {
    if (existing.state === 'CLAIMED') throw new CanonicalDataError(`附件正在清理，不能修改：${input.storageKey}`);
    Object.assign(existing, { ...input, id, state: 'PENDING', attempts: existing.attempts });
    return;
  }
  snapshot.operational.cleanupIntents.push({ ...input, id, state: 'PENDING', attempts: 0 });
}

export function bindAttachmentUpload(
  snapshot: CanonicalSnapshot,
  input: NewAttachmentUpload,
  now: Date,
  uploadTtlMs: number,
): void {
  if (snapshot.operational.uploads.some((upload) => upload.uploadId === input.uploadId)) {
    throw new CanonicalDataError('附件 uploadId 已存在');
  }
  if (snapshot.operational.uploads.some((upload) => upload.storageKey === input.storageKey)) {
    throw new CanonicalDataError('附件 storageKey 已存在上传会话');
  }
  snapshot.operational.uploads.push({
    ...input,
    parts: [],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + uploadTtlMs).toISOString(),
  });
  upsertCleanupIntent(snapshot, {
    storageKey: input.storageKey,
    operation: 'ABORT_MULTIPART',
    uploadId: input.uploadId,
    notBefore: new Date(now.getTime() + uploadTtlMs).toISOString(),
  });
}

export function requireAttachmentUpload(
  snapshot: CanonicalSnapshot,
  input: Pick<AttachmentUploadState, 'uploadId' | 'scope' | 'ownerId' | 'version'> & { attachmentId?: string },
  now?: Date,
): AttachmentUploadState {
  const upload = snapshot.operational.uploads.find((item) => item.uploadId === input.uploadId);
  if (!upload || upload.scope !== input.scope || upload.ownerId !== input.ownerId || upload.version !== input.version ||
    (input.attachmentId && upload.attachmentId !== input.attachmentId)) {
    throw new CanonicalDataError('附件上传会话与资源不匹配');
  }
  if (now && new Date(upload.expiresAt).getTime() <= now.getTime()) throw new CanonicalDataError('附件上传会话已过期');
  return structuredClone(upload);
}

export function recordAttachmentPart(
  snapshot: CanonicalSnapshot,
  uploadId: string,
  part: AttachmentUploadState['parts'][number],
): void {
  const upload = snapshot.operational.uploads.find((item) => item.uploadId === uploadId);
  if (!upload) throw new CanonicalDataError('找不到附件上传会话');
  upload.parts = [...upload.parts.filter((item) => item.partNumber !== part.partNumber), part]
    .sort((left, right) => left.partNumber - right.partNumber);
}

export function recordAttachmentObjectMetadata(snapshot: CanonicalSnapshot, uploadId: string, sha256?: string): void {
  const upload = snapshot.operational.uploads.find((item) => item.uploadId === uploadId);
  if (!upload) throw new CanonicalDataError('找不到附件上传会话');
  if (sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(sha256)) throw new CanonicalDataError('附件 SHA-256 无效');
  upload.sha256 = sha256?.toLowerCase();
}

export function recordUnboundAttachmentAbort(
  snapshot: CanonicalSnapshot,
  input: { storageKey: string; uploadId: string },
  now: Date,
): void {
  if (snapshot.operational.uploads.some((upload) => upload.uploadId === input.uploadId)) return;
  upsertCleanupIntent(snapshot, {
    storageKey: input.storageKey,
    operation: 'ABORT_MULTIPART',
    uploadId: input.uploadId,
    notBefore: now.toISOString(),
  });
}

export function prepareAttachmentCompletion(snapshot: CanonicalSnapshot, uploadId: string, now: Date): AttachmentUploadState {
  const upload = snapshot.operational.uploads.find((item) => item.uploadId === uploadId);
  if (!upload) throw new CanonicalDataError('找不到附件上传会话');
  if (new Date(upload.expiresAt).getTime() <= now.getTime()) throw new CanonicalDataError('附件上传会话已过期');
  const uploadedBytes = upload.parts.reduce((sum, part) => sum + part.sizeBytes, 0);
  if (uploadedBytes !== upload.expectedSizeBytes) throw new CanonicalDataError('附件分片总大小与初始化大小不一致');
  upsertCleanupIntent(snapshot, {
    storageKey: upload.storageKey,
    operation: 'DELETE_OBJECT',
    notBefore: now.toISOString(),
  });
  return structuredClone(upload);
}

export function finishAttachmentUpload(snapshot: CanonicalSnapshot, uploadId: string): void {
  const upload = snapshot.operational.uploads.find((item) => item.uploadId === uploadId);
  if (!upload) throw new CanonicalDataError('找不到附件上传会话');
  snapshot.operational.uploads = snapshot.operational.uploads.filter((item) => item.uploadId !== uploadId);
  snapshot.operational.cleanupIntents = snapshot.operational.cleanupIntents.filter((intent) =>
    !(intent.storageKey === upload.storageKey &&
      (intent.operation === 'DELETE_OBJECT' || (intent.operation === 'ABORT_MULTIPART' && intent.uploadId === uploadId))));
}

export function abandonAttachmentUpload(snapshot: CanonicalSnapshot, uploadId: string, now: Date): void {
  const upload = snapshot.operational.uploads.find((item) => item.uploadId === uploadId);
  if (!upload) return;
  snapshot.operational.uploads = snapshot.operational.uploads.filter((item) => item.uploadId !== uploadId);
  const intent = snapshot.operational.cleanupIntents.find((item) =>
    item.operation === 'ABORT_MULTIPART' && item.uploadId === uploadId);
  if (intent?.state === 'PENDING') intent.notBefore = now.toISOString();
}

export function reconcileAttachmentOperations(
  current: CanonicalSnapshot,
  next: CanonicalSnapshot,
  now: Date,
  retentionMs: number,
): CanonicalSnapshot {
  const state = structuredClone(next.operational);
  next.operational = state;
  const active = activeManagedStorageKeys(next);
  state.cleanupIntents = state.cleanupIntents.filter((intent) => {
    if (!active.has(intent.storageKey) || intent.operation !== 'DELETE_OBJECT') return true;
    if (intent.state === 'CLAIMED') throw new CanonicalDataError(`附件正在清理，不能重新引用：${intent.storageKey}`);
    return state.uploads.some((upload) => upload.storageKey === intent.storageKey);
  });

  const nextNames = new Set(next.attachments.map((item) => item.name));
  for (const attachment of current.attachments) {
    if (!attachment.storageKey || nextNames.has(attachment.name)) continue;
    upsertCleanupIntent(next, {
      storageKey: attachment.storageKey,
      operation: 'DELETE_OBJECT',
      notBefore: new Date(now.getTime() + retentionMs).toISOString(),
    });
  }
  return next;
}

export function assertAttachmentUploadsComplete(
  snapshot: CanonicalSnapshot,
  owner: Pick<AttachmentUploadState, 'scope' | 'ownerId' | 'version'>,
): void {
  const pending = snapshot.operational.uploads.find((upload) =>
    upload.scope === owner.scope && upload.ownerId === owner.ownerId && upload.version === owner.version);
  if (pending) throw new CanonicalDataError(`附件尚未完成上传，不能确认：${pending.filename}`);
}

export function addRollbackAttachmentLeases(snapshot: CanonicalSnapshot, generationId: string, expiresAt?: string): CanonicalSnapshot {
  const next = structuredClone(snapshot);
  const existing = new Set(next.operational.leases.map((lease) => `${lease.generationId}:${lease.storageKey}`));
  const storageKeys = new Set([
    ...next.attachments.flatMap((attachment) => attachment.storageKey ? [attachment.storageKey] : []),
    ...referencedManagedStorageKeys(next),
  ]);
  for (const storageKey of storageKeys) {
    const key = `${generationId}:${storageKey}`;
    if (!existing.has(key)) next.operational.leases.push({ storageKey, generationId, expiresAt });
  }
  return next;
}
