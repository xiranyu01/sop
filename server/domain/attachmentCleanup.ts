import type { AppStore, AttachmentCleanupIntent, CanonicalSnapshot } from './appStore';
import type { AttachmentObjectStore } from './attachmentObjectStore';
import { hasActiveLease, referencedManagedStorageKeys } from './attachmentReachability';
import { AtomicCommitError } from './errors';

export type AttachmentCleanupOptions = {
  namespace?: string;
  clock?: () => Date;
  claimTimeoutMs?: number;
  retryDelayMs?: number;
  workerId?: string;
  maxItems?: number;
};

async function commitRetry(
  store: AppStore,
  namespace: string | undefined,
  mutation: (snapshot: CanonicalSnapshot) => CanonicalSnapshot,
) {
  let pin = await store.pin(namespace);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { return await store.commit(pin, mutation); } catch (error) {
      if (!(error instanceof AtomicCommitError) || attempt === 4) throw error;
      pin = await store.pin(namespace);
    }
  }
  throw new AtomicCommitError('Attachment cleanup commit retry exhausted');
}

export async function runAttachmentCleanup(
  store: AppStore,
  objects: Pick<AttachmentObjectStore, 'deleteAttachment' | 'abortAttachmentUpload'>,
  options: AttachmentCleanupOptions = {},
): Promise<{ deleted: number; aborted: number; failed: number }> {
  const now = options.clock?.() ?? new Date();
  const workerId = options.workerId ?? crypto.randomUUID();
  const claimTimeout = options.claimTimeoutMs ?? 5 * 60_000;
  const retryDelay = options.retryDelayMs ?? 60_000;
  const claimed: AttachmentCleanupIntent[] = [];
  await commitRetry(store, options.namespace, (snapshot) => {
    // commitRetry can invoke this mutation more than once after a CAS miss.
    // Only retain claims from the attempt that is actually being committed.
    claimed.length = 0;
    const next = structuredClone(snapshot);
    const references = referencedManagedStorageKeys(next);
    const uploading = new Set(next.operational.uploads.map((upload) => upload.storageKey));
    for (const intent of next.operational.cleanupIntents) {
      if (claimed.length >= (options.maxItems ?? 32)) break;
      const staleClaim = intent.state === 'CLAIMED' && intent.claimedAt && new Date(intent.claimedAt).getTime() + claimTimeout <= now.getTime();
      if (intent.state === 'CLAIMED' && !staleClaim) continue;
      if (new Date(intent.notBefore).getTime() > now.getTime()) continue;
      if (intent.operation === 'DELETE_OBJECT' &&
        (uploading.has(intent.storageKey) || references.has(intent.storageKey) || hasActiveLease(next, intent.storageKey, now))) continue;
      intent.state = 'CLAIMED';
      intent.claimId = workerId;
      intent.claimedAt = now.toISOString();
      claimed.push(structuredClone(intent));
    }
    return next;
  });

  let deleted = 0; let aborted = 0; let failed = 0;
  for (const intent of claimed) {
    try {
      if (intent.operation === 'DELETE_OBJECT') {
        await objects.deleteAttachment(intent.storageKey); deleted += 1;
      } else {
        await objects.abortAttachmentUpload({ storageKey: intent.storageKey, uploadId: intent.uploadId! }); aborted += 1;
      }
      await commitRetry(store, options.namespace, (snapshot) => ({
        ...snapshot,
        operational: {
          ...snapshot.operational,
          cleanupIntents: snapshot.operational.cleanupIntents.filter((item) => !(item.id === intent.id && item.claimId === workerId)),
          uploads: intent.operation === 'ABORT_MULTIPART'
            ? snapshot.operational.uploads.filter((upload) =>
              !(upload.uploadId === intent.uploadId && upload.storageKey === intent.storageKey))
            : snapshot.operational.uploads,
        },
      }));
    } catch (error) {
      failed += 1;
      await commitRetry(store, options.namespace, (snapshot) => {
        const next = structuredClone(snapshot);
        const current = next.operational.cleanupIntents.find((item) => item.id === intent.id && item.claimId === workerId);
        if (current) {
          // The provider may have completed the destructive operation before
          // returning an error. Keep the tombstone claimed so ordinary CRUD
          // cannot re-introduce a key whose physical state is unknown.
          current.state = 'CLAIMED'; current.claimedAt = now.toISOString();
          current.attempts += 1; current.lastError = error instanceof Error ? error.message : String(error);
          current.notBefore = new Date(now.getTime() + retryDelay).toISOString();
        }
        return next;
      });
    }
  }
  return { deleted, aborted, failed };
}
