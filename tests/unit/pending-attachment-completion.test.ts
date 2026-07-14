import { describe, expect, it } from 'vitest';
import {
  findPendingAttachmentCompletion,
  pendingAttachmentCompletionMatchesFile,
  removePendingAttachmentCompletion,
  savePendingAttachmentCompletion,
  type PendingAttachmentCompletion,
} from '../../src/api/pendingAttachmentCompletion';

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const pending: PendingAttachmentCompletion = {
  kind: 'materials',
  ownerName: 'materials/material-001',
  uid: 'attachment-001',
  fileName: 'inspection.png',
  mediaType: 'image/png',
  sizeBytes: 42,
  lastModified: 1_720_000_000_000,
};

describe('pending attachment completion storage', () => {
  it('restores the same completion after a reload without persisting bytes, object keys, or credentials', () => {
    const storage = new MemoryStorage();
    savePendingAttachmentCompletion(storage, pending);

    expect(findPendingAttachmentCompletion(storage, pending.kind, pending.ownerName)).toEqual(pending);
    const serialized = [...storage.values.values()].join('');
    expect(serialized).not.toMatch(/objectKey|password|bytes/u);
  });

  it('matches only the original file fingerprint and removes the record after success', () => {
    const storage = new MemoryStorage();
    savePendingAttachmentCompletion(storage, pending);
    const restored = findPendingAttachmentCompletion(storage, pending.kind, pending.ownerName)!;

    expect(pendingAttachmentCompletionMatchesFile(restored, {
      name: pending.fileName,
      type: pending.mediaType,
      size: pending.sizeBytes,
      lastModified: pending.lastModified,
    })).toBe(true);
    expect(pendingAttachmentCompletionMatchesFile(restored, {
      name: pending.fileName,
      type: pending.mediaType,
      size: pending.sizeBytes,
      lastModified: pending.lastModified + 1,
    })).toBe(false);

    removePendingAttachmentCompletion(storage, pending.kind, pending.ownerName, pending.uid);
    expect(findPendingAttachmentCompletion(storage, pending.kind, pending.ownerName)).toBeUndefined();
    expect(storage.values.size).toBe(0);
  });

  it('ignores malformed persisted data instead of blocking new uploads', () => {
    const storage = new MemoryStorage();
    storage.setItem('sop:pending-attachment-completions:v1', '{not-json');
    expect(findPendingAttachmentCompletion(storage, 'materials', pending.ownerName)).toBeUndefined();
  });
});
