import { create } from '@bufbuild/protobuf';
import { describe, expect, it, vi } from 'vitest';
import { AttachmentSchema, MaterialSchema } from '../../gen/coscene/sop/v1alpha1/catalog_pb';
import { RevisionOrigin } from '../../gen/coscene/sop/v1alpha1/common_pb';
import { emptyCanonicalSnapshot } from '../../server/domain/appStore';
import { attachmentOwnership, hasActiveLease, publicAttachmentUri, referencedManagedStorageKeys } from '../../server/domain/attachmentReachability';
import {
  addRollbackAttachmentLeases,
  bindAttachmentUpload,
  cleanupIntentId,
  reconcileAttachmentOperations,
  requireAttachmentUpload,
} from '../../server/domain/attachmentService';

describe('attachment ownership and reachability', () => {
  it('distinguishes managed bytes from external HTTPS data without fetching external URIs', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const externalUri = 'https://cdn.example.test/%7Efile?q=a%2Fb#原样';
    const external = create(AttachmentSchema, { uri: externalUri });
    expect(attachmentOwnership(external)).toEqual({ kind: 'external', publicUri: externalUri });
    expect(publicAttachmentUri(external)).toBe(externalUri);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(() => attachmentOwnership(create(AttachmentSchema, { uri: 'http://unsafe.test/file' }))).toThrow('HTTPS');
  });

  it('constructs managed public URIs and rejects a missing or non-HTTPS base', () => {
    const managed = create(AttachmentSchema, { storageKey: 'requirements/REQ 1/tiny.txt' });
    expect(publicAttachmentUri(managed, 'https://objects.example.test/public/'))
      .toBe('https://objects.example.test/public/requirements/REQ%201/tiny.txt');
    expect(() => publicAttachmentUri(managed)).toThrow('base URL');
    expect(() => publicAttachmentUri(managed, 'http://objects.test')).toThrow('HTTPS');
  });

  it('keeps frozen revision references and unexpired rollback leases reachable', () => {
    const snapshot = emptyCanonicalSnapshot();
    const attachment = create(AttachmentSchema, {
      name: 'attachments/frozen', filename: 'frozen.txt', mediaType: 'text/plain', storageKey: 'managed/frozen.txt',
    });
    snapshot.attachments = [attachment];
    snapshot.requirementRevisions = [{
      $typeName: 'coscene.sop.v1alpha1.RequirementRevision', name: 'requirements/r/revisions/v1', versionLabel: '1.0.0',
      uid: '00000000-0000-4000-8000-000000000100',
      origin: RevisionOrigin.IMPORTED_CONFIRMED,
      exportEligible: true,
      frozenDependencies: { $typeName: 'coscene.sop.v1alpha1.FrozenDependencyContext', customers: [], materials: [], scenes: [], globalFields: [], materialStateRules: [], attachments: [attachment] },
    }];
    snapshot.operational.leases = [{ storageKey: 'managed/rollback.txt', generationId: 'previous', expiresAt: '2030-01-01T00:00:00.000Z' }];

    expect(referencedManagedStorageKeys(snapshot)).toContain('managed/frozen.txt');
    expect(hasActiveLease(snapshot, 'managed/rollback.txt', new Date('2029-01-01T00:00:00.000Z'))).toBe(true);
    expect(hasActiveLease(snapshot, 'managed/rollback.txt', new Date('2031-01-01T00:00:00.000Z'))).toBe(false);

    snapshot.attachments = [];
    expect(addRollbackAttachmentLeases(snapshot, 'validated-generation', '2030-01-01T00:00:00.000Z').operational.leases)
      .toContainEqual({
        storageKey: 'managed/frozen.txt', generationId: 'validated-generation', expiresAt: '2030-01-01T00:00:00.000Z',
      });
  });

  it('expires bound sessions and cancels only pending deletion when a key is actively re-referenced', () => {
    const current = emptyCanonicalSnapshot();
    bindAttachmentUpload(current, {
      uploadId: 'upload-1', storageKey: 'managed/new.bin', attachmentName: 'attachments/new', attachmentId: 'new',
      filename: 'new.bin', mediaType: 'application/octet-stream', expectedSizeBytes: 1,
      scope: 'requirement', ownerId: 'REQ001', version: '0.0.1',
    }, new Date('2026-01-01T00:00:00.000Z'), 1000);
    expect(() => requireAttachmentUpload(current, {
      uploadId: 'upload-1', scope: 'requirement', ownerId: 'REQ001', version: '0.0.1',
    }, new Date('2026-01-01T00:00:01.000Z'))).toThrow('已过期');

    const next = emptyCanonicalSnapshot();
    next.operational.cleanupIntents = [{
      id: cleanupIntentId('DELETE_OBJECT', 'managed/reused.bin'), storageKey: 'managed/reused.bin',
      state: 'PENDING', operation: 'DELETE_OBJECT', notBefore: '2026-01-01T00:00:00.000Z', attempts: 0,
    }];
    next.attachments = [create(AttachmentSchema, {
      name: 'attachments/reused', filename: 'reused.bin', mediaType: 'application/octet-stream', storageKey: 'managed/reused.bin',
    })];
    next.materials = [create(MaterialSchema, { name: 'materials/reused', displayName: 'reused', images: ['attachments/reused'] })];
    expect(reconcileAttachmentOperations(emptyCanonicalSnapshot(), next, new Date('2026-01-01T00:00:00.000Z'), 0)
      .operational.cleanupIntents).toEqual([]);

    next.operational.cleanupIntents[0] = {
      id: cleanupIntentId('DELETE_OBJECT', 'managed/reused.bin'), storageKey: 'managed/reused.bin',
      state: 'CLAIMED', operation: 'DELETE_OBJECT', claimId: 'worker', claimedAt: '2026-01-01T00:00:00.000Z',
      notBefore: '2026-01-01T00:00:00.000Z', attempts: 0,
    };
    expect(() => reconcileAttachmentOperations(emptyCanonicalSnapshot(), next, new Date('2026-01-01T00:00:00.000Z'), 0))
      .toThrow('正在清理');
  });
});
