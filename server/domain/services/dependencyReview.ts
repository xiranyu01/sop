import { create, toBinary } from '@bufbuild/protobuf';
import {
  DependencyReviewProposalSchema,
  type DependencyKind,
  type DependencyReviewProposal,
  type DependencyToken,
} from '../../../gen/coscene/sop/v1alpha1/common_pb';
import { sha256 } from '../../../shared/crypto/hash';
import { assertValidDomainMessage } from '../../../shared/domain/validation';
import { CanonicalDataError } from '../errors';

export const MAX_DIRECT_DEPENDENCIES = 500;

export type DirectDependency = {
  kind: DependencyKind;
  resourceName: string;
  token: string;
};

export type DependencyChange = {
  kind: DependencyKind;
  resourceName: string;
  beforeToken?: string;
  afterToken?: string;
};

export type DependencyDiff = {
  digest: string;
  proposal: DependencyReviewProposal;
  added: DependencyChange[];
  removed: DependencyChange[];
  changed: DependencyChange[];
  empty: boolean;
};

function compare(left: DirectDependency, right: DirectDependency): number {
  return left.kind - right.kind || left.resourceName.localeCompare(right.resourceName, 'en') || left.token.localeCompare(right.token, 'en');
}

function key(value: Pick<DirectDependency, 'kind' | 'resourceName'>): string {
  return `${value.kind}\u0000${value.resourceName}`;
}

export function normalizeDirectDependencies(values: Iterable<DirectDependency>): DependencyToken[] {
  const sorted = [...values].map((value) => ({ ...value })).sort(compare);
  if (sorted.length > MAX_DIRECT_DEPENDENCIES) {
    throw new CanonicalDataError(`Direct dependency limit exceeded: ${sorted.length} > ${MAX_DIRECT_DEPENDENCIES}`);
  }
  const seen = new Set<string>();
  for (const value of sorted) {
    const id = key(value);
    if (seen.has(id)) throw new CanonicalDataError(`Duplicate direct dependency: ${value.resourceName}`);
    seen.add(id);
  }
  return sorted.map((value) => ({
    $typeName: 'coscene.sop.v1alpha1.DependencyToken',
    kind: value.kind,
    resourceName: value.resourceName,
    token: value.token,
  }));
}

export function buildDependencyReviewProposal(
  rootName: string,
  rootEtag: string,
  values: Iterable<DirectDependency>,
): DependencyReviewProposal {
  const proposal = create(DependencyReviewProposalSchema, {
    rootName,
    rootEtag,
    dependencies: normalizeDirectDependencies(values),
  });
  return assertValidDomainMessage(DependencyReviewProposalSchema, proposal);
}

export function dependencyProposalDigest(proposal: DependencyReviewProposal): string {
  assertValidDomainMessage(DependencyReviewProposalSchema, proposal);
  return sha256(toBinary(DependencyReviewProposalSchema, proposal, { writeUnknownFields: false }));
}

export function diffDependencies(
  proposal: DependencyReviewProposal,
  reviewed: Iterable<DirectDependency>,
): DependencyDiff {
  const previous = new Map(normalizeDirectDependencies(reviewed).map((value) => [key(value), value]));
  const current = new Map(proposal.dependencies.map((value) => [key(value), value]));
  const added: DependencyChange[] = [];
  const removed: DependencyChange[] = [];
  const changed: DependencyChange[] = [];

  for (const [id, value] of current) {
    const before = previous.get(id);
    if (!before) added.push({ kind: value.kind, resourceName: value.resourceName, afterToken: value.token });
    else if (before.token !== value.token) {
      changed.push({ kind: value.kind, resourceName: value.resourceName, beforeToken: before.token, afterToken: value.token });
    }
  }
  for (const [id, value] of previous) {
    if (!current.has(id)) removed.push({ kind: value.kind, resourceName: value.resourceName, beforeToken: value.token });
  }
  const sortChanges = (values: DependencyChange[]) => values.sort((left, right) =>
    left.kind - right.kind || left.resourceName.localeCompare(right.resourceName, 'en'));
  sortChanges(added); sortChanges(removed); sortChanges(changed);
  return {
    digest: dependencyProposalDigest(proposal),
    proposal,
    added,
    removed,
    changed,
    empty: added.length === 0 && removed.length === 0 && changed.length === 0,
  };
}

export function assertDependencyProposalDigest(proposal: DependencyReviewProposal, expectedDigest: string): void {
  const actual = dependencyProposalDigest(proposal);
  if (actual !== expectedDigest) {
    throw new CanonicalDataError(`Dependency proposal digest changed: expected ${expectedDigest}, got ${actual}`);
  }
}

