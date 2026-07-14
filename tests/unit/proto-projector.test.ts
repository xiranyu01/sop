import { describe, expect, it } from 'vitest';
import {
  projectBundle,
  projectionDifferences,
  projectResource,
  projectRevision,
  withResourceEtag,
  withReviewedDependencyDigest,
} from '../../server/repositories/protoProjector';

const json = (value: unknown) => JSON.stringify(value);

describe('ProtoJSON storage projector', () => {
  it('derives catalog identity, kind, source id, display name, and etag from ProtoJSON', () => {
    expect(projectResource('coscene.sop.v1alpha1.Material', json({
      name: 'materials/cup',
      uid: 'material-uid',
      source_id: 'ERP-42',
      displayName: 'Cup',
      etag: 'etag-material-1',
    }))).toEqual({
      name: 'materials/cup',
      uid: 'material-uid',
      kind: 'MATERIAL',
      sourceId: 'ERP-42',
      displayName: 'Cup',
      etag: 'etag-material-1',
    });

    expect(projectResource('coscene/sop/v1alpha1/GlobalField', json({
      name: 'globalFields/site', uid: 'field-uid', label: 'Site', etag: 'etag-field-1',
    })).displayName).toBe('Site');
    expect(projectResource('Attachment', json({
      name: 'attachments/manual', uid: 'attachment-uid', filename: 'manual.pdf', etag: 'etag-attachment-1',
    })).displayName).toBe('manual.pdf');
    expect(projectResource('MaterialStateRule', json({
      name: 'materialStateRules/wet', uid: 'rule-uid', material_type: 'Wet', etag: 'etag-rule-1',
    })).displayName).toBe('Wet');
  });

  it('derives current-resource lifecycle and current revision, including the RobotModel ACTIVE default', () => {
    expect(projectResource('TaskSop', json({
      name: 'taskSops/wash-cup',
      uid: 'task-uid',
      display_name: 'Wash cup',
      etag: 'etag-task-1',
      lifecycle: 'LIFECYCLE_DRAFT',
      candidate_version_sequence: '2',
      candidate_version_label: '0.0.2',
      candidate_source_version_id: 'legacy-version-2',
      current_revision: 'taskSops/wash-cup/revisions/0-0-1',
      reviewed_dependency_digest: 'digest-2',
    }))).toEqual({
      name: 'taskSops/wash-cup',
      uid: 'task-uid',
      kind: 'TASK_SOP',
      sourceId: undefined,
      displayName: 'Wash cup',
      etag: 'etag-task-1',
      lifecycle: 'DRAFT',
      candidateVersionSequence: 2,
      candidateVersionLabel: '0.0.2',
      candidateSourceVersionId: 'legacy-version-2',
      currentRevisionName: 'taskSops/wash-cup/revisions/0-0-1',
      reviewedManifestDigest: 'digest-2',
    });

    expect(projectResource('RobotModel', json({
      name: 'robotModels/ur5', uid: 'robot-uid', displayName: 'UR5', etag: 'etag-robot-1',
    }))).toMatchObject({
      kind: 'ROBOT_MODEL',
      lifecycle: 'ACTIVE',
    });
  });

  it('derives immutable revision columns from the revision and its complete snapshot', () => {
    expect(projectRevision('coscene.sop.v1alpha1.TaskSopRevision', json({
      name: 'taskSops/wash-cup/revisions/0-0-2',
      uid: 'task-revision-uid',
      snapshot: {
        name: 'taskSops/wash-cup',
        lifecycle: 'LIFECYCLE_CONFIRMED',
      },
      previous_revision: 'taskSops/wash-cup/revisions/0-0-1',
      version_label: '0.0.2',
      origin: 'REVISION_ORIGIN_IMPORTED_CONFIRMED',
      export_eligible: true,
    }), {
      revisionOrigin: 'IMPORTED_DRAFT_CHECKPOINT',
      lifecycle: 'DRAFT',
      exportEligible: false,
    })).toEqual({
      name: 'taskSops/wash-cup/revisions/0-0-2',
      uid: 'task-revision-uid',
      ownerName: 'taskSops/wash-cup',
      kind: 'TASK_SOP_REVISION',
      versionLabel: '0.0.2',
      previousRevisionName: 'taskSops/wash-cup/revisions/0-0-1',
      revisionOrigin: 'IMPORTED_CONFIRMED',
      lifecycle: 'CONFIRMED',
      exportEligible: true,
    });

    expect(projectRevision('RequirementRevision', json({
      name: 'requirements/order/revisions/imported-draft',
      uid: 'requirement-revision-uid',
      snapshot: { name: 'requirements/order', lifecycle: 1 },
      versionLabel: '0.0.1',
      origin: 3,
      exportEligible: false,
    }))).toMatchObject({
      kind: 'REQUIREMENT_REVISION',
      revisionOrigin: 'IMPORTED_DRAFT_CHECKPOINT',
      lifecycle: 'DRAFT',
      exportEligible: false,
    });
  });

  it('accepts physical origin/lifecycle for legacy RobotModel revisions but keeps them export-ineligible', () => {
    expect(projectRevision('RobotModelRevision', json({
      name: 'robotModels/ur5/revisions/0-0-1',
      uid: 'robot-revision-uid',
      snapshot: { name: 'robotModels/ur5' },
      version_label: '0.0.1',
    }), {
      revisionOrigin: 'IMPORTED_CONFIRMED',
      lifecycle: 'CONFIRMED',
      exportEligible: false,
    })).toEqual({
      name: 'robotModels/ur5/revisions/0-0-1',
      uid: 'robot-revision-uid',
      ownerName: 'robotModels/ur5',
      kind: 'ROBOT_MODEL_REVISION',
      versionLabel: '0.0.1',
      previousRevisionName: undefined,
      revisionOrigin: 'IMPORTED_CONFIRMED',
      lifecycle: 'CONFIRMED',
      exportEligible: false,
    });
  });

  it('derives sealed-bundle lookup and integrity columns, accepting ProtoJSON int64 strings', () => {
    expect(projectBundle(json({
      schema_version: '1.0.0',
      content_size_bytes: '2048',
      content_sha256: 'a'.repeat(64),
      content: {
        revision_name: 'taskSops/wash-cup/revisions/0-0-2',
        renderer_version: 'renderer-1',
        root: { kind: 'ROOT_KIND_TASK_SOP' },
      },
    }))).toEqual({
      rootRevisionName: 'taskSops/wash-cup/revisions/0-0-2',
      rootKind: 'TASK_SOP',
      schemaVersion: '1.0.0',
      rendererVersion: 'renderer-1',
      contentSizeBytes: 2048,
      contentSha256: 'a'.repeat(64),
    });

    expect(projectBundle(json({
      schemaVersion: '1.0.0',
      contentSizeBytes: 1,
      contentSha256: 'b'.repeat(64),
      content: {
        revisionName: 'requirements/order/revisions/1-0-0',
        rendererVersion: 'renderer-1',
        root: { kind: 1 },
      },
    })).rootKind).toBe('REQUIREMENT');
  });

  it('rewrites only the etag and identifies every persisted projection mismatch', () => {
    const rewritten = JSON.parse(withResourceEtag(json({
      name: 'materials/cup', uid: 'material-uid', etag: 'old', displayName: 'Cup',
    }), 'new')) as Record<string, unknown>;
    expect(rewritten).toEqual({
      name: 'materials/cup', uid: 'material-uid', etag: 'new', displayName: 'Cup',
    });

    expect(JSON.parse(withReviewedDependencyDigest(json({
      name: 'taskSops/wash',
      etag: 'old',
      reviewed_dependency_digest: 'old-digest',
    }), 'new', 'new-digest'))).toEqual({
      name: 'taskSops/wash',
      etag: 'new',
      reviewedDependencyDigest: 'new-digest',
    });

    expect(projectionDifferences({
      name: 'materials/cup',
      sourceId: null,
      displayName: 'Wrong',
      etag: 'old',
    }, {
      name: 'materials/cup',
      sourceId: undefined,
      displayName: 'Cup',
      etag: 'new',
    })).toEqual(['displayName', 'etag']);
  });

  it('fails closed for malformed, incomplete, unsupported, or wrong-category ProtoJSON', () => {
    expect(() => projectResource('Material', 'not json')).toThrow('resource ProtoJSON is invalid');
    expect(() => projectResource('Material', '[]')).toThrow('resource ProtoJSON must be an object');
    expect(() => projectResource('UnknownResource', json({ name: 'x', uid: 'y', etag: 'z' })))
      .toThrow('Unsupported Proto schema');
    expect(() => projectResource('Material', json({ name: 'materials/cup', uid: 'uid', displayName: 'Cup' })))
      .toThrow('etag must be a non-empty string');
    expect(() => projectResource('TaskSopRevision', json({}))).toThrow('is a revision schema');
    expect(() => projectRevision('TaskSop', json({}))).toThrow('is not a revision schema');
    expect(() => projectBundle(json({ content: { root: { kind: 0 } } })))
      .toThrow('Unsupported bundle root kind');
  });
});
