import { describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '@bufbuild/protobuf';
import {
  attachmentFormFromMetadata,
  attachmentReferenceNames,
  findTaskSop,
  loadReferencedAttachmentMetadata,
  sourceLikeId,
} from '../../src/App';
import { ApiClientError, type AttachmentMetadata } from '../../src/api/client';
import type { ResourceSummary } from '../../shared/transport/resourceDto';
import type { RequirementVersion, Scene } from '../../src/domain/viewModels';

describe('resource detail hydration', () => {
  it('discovers unique attachment resource references and hydrates their metadata by uid', async () => {
    const resources = [{
      images: ['attachments/photo-1', 'attachments/photo-1'],
      nested: { attachments: ['attachments/manual-2'] },
      storageKey: 'attachments/material/owner/photo-1',
      publicUrl: 'https://assets.example.test/photo-1',
    }] as JsonValue[];
    const getMetadata = vi.fn(async (uid: string): Promise<AttachmentMetadata> => ({
      owner: { scope: 'material', uid: 'owner' },
      uid,
      objectKey: `attachments/material/owner/${uid}`,
      filename: `${uid}.png`,
      mediaType: 'image/png',
      sizeBytes: 42,
      publicUrl: `https://assets.example.test/${uid}`,
      metadata: {},
      name: `attachments/${uid}`,
    }));

    expect(attachmentReferenceNames(resources)).toEqual([
      'attachments/photo-1',
      'attachments/manual-2',
    ]);
    const metadata = await loadReferencedAttachmentMetadata(resources, getMetadata);
    expect(getMetadata.mock.calls.map(([uid]) => uid)).toEqual(['photo-1', 'manual-2']);
    expect(metadata.map(attachmentFormFromMetadata)).toEqual([
      expect.objectContaining({
        id: 'photo-1', name: 'photo-1.png', contentType: 'image/png', size: 42,
        storageKey: 'https://assets.example.test/photo-1',
      }),
      expect.objectContaining({ id: 'manual-2', name: 'manual-2.png' }),
    ]);
  });

  it('uses the projected source id for the summary identity and falls back to the name tail', () => {
    const base = {
      kind: 'scenes', uid: 'uid', displayName: 'Scene', etag: 'etag', archived: false,
    } as const;
    expect(sourceLikeId({ ...base, name: 'scenes/canonical-scene', sourceId: 'legacy-scene-id' } as ResourceSummary))
      .toBe('legacy-scene-id');
    expect(sourceLikeId({ ...base, name: 'scenes/canonical-scene' } as ResourceSummary))
      .toBe('canonical-scene');
  });

  it('bounds metadata requests and keeps missing historical references as placeholders', async () => {
    const resources = [{ attachments: Array.from({ length: 7 }, (_, index) => `attachments/item-${index}`) }] as JsonValue[];
    let active = 0;
    let maximumActive = 0;
    const getMetadata = vi.fn(async (uid: string): Promise<AttachmentMetadata> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      if (uid === 'item-3') throw new ApiClientError(404);
      return {
        owner: { scope: 'requirement', uid: 'owner' }, uid, objectKey: `attachments/requirement/owner/${uid}`,
        filename: uid, mediaType: 'application/octet-stream', sizeBytes: 1, metadata: {},
      };
    });

    const metadata = await loadReferencedAttachmentMetadata(resources, getMetadata, { concurrency: 2 });

    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(metadata).toHaveLength(6);
    expect(metadata.map((item) => item.uid)).not.toContain('item-3');
  });

  it('resolves a duplicated legacy task code inside the referenced scene', () => {
    const version = (title: string) => ({ version: '1.0.0', title, status: 'confirmed' });
    const scenes = [
      { id: 'scene-a', name: 'Scene A', description: '', subscenes: [{ code: 'DUP', name: 'Task A', versions: [version('Task A')] }] },
      { id: 'scene-b', name: 'Scene B', description: '', subscenes: [{ code: 'DUP', name: 'Task B', versions: [version('Task B')] }] },
    ] as Scene[];
    const selected = {
      subsceneCode: 'DUP',
      sceneName: 'Scene B',
      subsceneName: 'Task B',
      version: '1.0.0',
      taskSop: { sceneName: 'Scene B', title: 'Task B', version: '1.0.0' },
    } as RequirementVersion['selectedSubscenes'][number];

    expect(findTaskSop(scenes, selected)?.scene.id).toBe('scene-b');
  });
});
