import { describe, expect, it } from 'vitest';
import { DependencyKind } from '../../gen/coscene/sop/v1alpha1/common_pb';
import {
  MAX_DIRECT_DEPENDENCIES,
  assertDependencyProposalDigest,
  buildDependencyReviewProposal,
  dependencyProposalDigest,
  diffDependencies,
} from '../../server/domain/services/dependencyReview';

describe('direct dependency review', () => {
  it('sorts a complete proposal deterministically and binds its digest to the root etag', () => {
    const dependencies = [
      { kind: DependencyKind.SCENE, resourceName: 'scenes/kitchen', token: 'e-scene' },
      { kind: DependencyKind.MATERIAL, resourceName: 'materials/cup', token: 'e-cup' },
    ];
    const first = buildDependencyReviewProposal('taskSops/place-cup', 'root-e1', dependencies);
    const second = buildDependencyReviewProposal('taskSops/place-cup', 'root-e1', dependencies.toReversed());
    expect(first.dependencies.map((value) => value.resourceName)).toEqual(['materials/cup', 'scenes/kitchen']);
    expect(dependencyProposalDigest(first)).toBe(dependencyProposalDigest(second));
    const nextRoot = buildDependencyReviewProposal('taskSops/place-cup', 'root-e2', dependencies);
    expect(dependencyProposalDigest(nextRoot)).not.toBe(dependencyProposalDigest(first));
  });

  it('returns stable added, removed, and token-changed sets', () => {
    const proposal = buildDependencyReviewProposal('requirements/demo', 'root-e1', [
      { kind: DependencyKind.CUSTOMER, resourceName: 'customers/acme', token: 'customer-e2' },
      { kind: DependencyKind.ROBOT_MODEL_REVISION, resourceName: 'robotModels/arm/revisions/2', token: 'robot-uid-2' },
    ]);
    const diff = diffDependencies(proposal, [
      { kind: DependencyKind.CUSTOMER, resourceName: 'customers/acme', token: 'customer-e1' },
      { kind: DependencyKind.TASK_SOP_REVISION, resourceName: 'taskSops/old/revisions/1', token: 'task-uid-1' },
    ]);
    expect(diff.changed).toEqual([{ kind: DependencyKind.CUSTOMER, resourceName: 'customers/acme', beforeToken: 'customer-e1', afterToken: 'customer-e2' }]);
    expect(diff.added).toEqual([{ kind: DependencyKind.ROBOT_MODEL_REVISION, resourceName: 'robotModels/arm/revisions/2', afterToken: 'robot-uid-2' }]);
    expect(diff.removed).toEqual([{ kind: DependencyKind.TASK_SOP_REVISION, resourceName: 'taskSops/old/revisions/1', beforeToken: 'task-uid-1' }]);
    expect(diff.empty).toBe(false);
  });

  it('accepts exactly 500 direct dependencies and rejects 501 before review', () => {
    const values = Array.from({ length: MAX_DIRECT_DEPENDENCIES }, (_, index) => ({
      kind: DependencyKind.MATERIAL,
      resourceName: `materials/item-${String(index).padStart(3, '0')}`,
      token: `etag-${index}`,
    }));
    expect(buildDependencyReviewProposal('taskSops/bulk', 'root-e1', values).dependencies).toHaveLength(500);
    expect(() => buildDependencyReviewProposal('taskSops/bulk', 'root-e1', [
      ...values,
      { kind: DependencyKind.MATERIAL, resourceName: 'materials/overflow', token: 'etag-overflow' },
    ])).toThrow('501 > 500');
  });

  it('rejects duplicate identities and stale acknowledgement digests', () => {
    const proposal = buildDependencyReviewProposal('taskSops/place-cup', 'root-e1', [
      { kind: DependencyKind.MATERIAL, resourceName: 'materials/cup', token: 'e1' },
    ]);
    expect(() => buildDependencyReviewProposal('taskSops/place-cup', 'root-e1', [
      { kind: DependencyKind.MATERIAL, resourceName: 'materials/cup', token: 'e1' },
      { kind: DependencyKind.MATERIAL, resourceName: 'materials/cup', token: 'e2' },
    ])).toThrow('Duplicate direct dependency');
    expect(() => assertDependencyProposalDigest(proposal, '0'.repeat(64))).toThrow('digest changed');
  });
});
