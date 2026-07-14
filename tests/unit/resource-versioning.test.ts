import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { FrozenDependencyContextSchema, RobotModelRevisionSchema, RobotModelSchema } from '../../gen/coscene/sop/v1alpha1/catalog_pb';
import { Lifecycle, RevisionOrigin } from '../../gen/coscene/sop/v1alpha1/common_pb';
import { RequirementRevisionSchema, RequirementSchema } from '../../gen/coscene/sop/v1alpha1/requirement_pb';
import { TaskSopRevisionSchema, TaskSopSchema } from '../../gen/coscene/sop/v1alpha1/task_sop_pb';
import {
  appendRobotModelRevision,
  buildRequirementConfirmation,
  buildTaskSopConfirmation,
  startNextRequirementDraft,
  startNextTaskSopDraft,
} from '../../server/domain/services/versioning';

const now = new Date('2026-07-14T10:00:00.000Z');
const frozen = create(FrozenDependencyContextSchema);

function confirmedTask() {
  const current = create(TaskSopSchema, {
    name: 'taskSops/demo', uid: '00000000-0000-4000-8000-000000000001', displayName: 'Demo',
    scene: 'scenes/demo', lifecycle: Lifecycle.CONFIRMED, spec: {}, currentRevision: 'taskSops/demo/revisions/v-1-0-0',
  });
  const revision = create(TaskSopRevisionSchema, {
    name: current.currentRevision, uid: '00000000-0000-4000-8000-000000000002', snapshot: current,
    versionLabel: '1.0.0', origin: RevisionOrigin.RUNTIME_CONFIRMED, exportEligible: true,
  });
  return { current, revision };
}

describe('resource-scoped versioning', () => {
  it('starts a TaskSop draft without creating a historical revision and confirms it deterministically', () => {
    const base = confirmedTask();
    const draft = startNextTaskSopDraft(base.current, base.revision, 2n, now);
    expect(draft).toMatchObject({
      lifecycle: Lifecycle.DRAFT, currentRevision: base.revision.name,
      candidateVersionSequence: 2n, candidateVersionLabel: '1.0.1',
    });
    const first = buildTaskSopConfirmation(draft, frozen, now);
    const retry = buildTaskSopConfirmation(draft, frozen, now);
    expect(retry).toEqual(first);
    expect(first.current.candidateVersionLabel).toBeUndefined();
    expect(first.revision).toMatchObject({
      versionLabel: '1.0.1', previousRevision: base.revision.name,
      origin: RevisionOrigin.RUNTIME_CONFIRMED, exportEligible: true,
    });
  });

  it('never promotes an imported draft checkpoint as a base revision', () => {
    const base = confirmedTask();
    const checkpoint = create(TaskSopRevisionSchema, {
      ...base.revision,
      snapshot: {
        ...base.current, lifecycle: Lifecycle.DRAFT,
        candidateVersionSequence: 2n, candidateVersionLabel: '1.0.1',
      },
      origin: RevisionOrigin.IMPORTED_DRAFT_CHECKPOINT,
      exportEligible: false,
    });
    expect(() => startNextTaskSopDraft(base.current, checkpoint, 3n, now)).toThrow('cannot be used as a draft base');
  });

  it('applies the same draft and confirmation rules to Requirements', () => {
    const current = create(RequirementSchema, {
      name: 'requirements/demo', uid: '00000000-0000-4000-8000-000000000003', displayName: 'Demo',
      lifecycle: Lifecycle.CONFIRMED, spec: {}, currentRevision: 'requirements/demo/revisions/v-1-0-0',
    });
    const base = create(RequirementRevisionSchema, {
      name: current.currentRevision, uid: '00000000-0000-4000-8000-000000000004', snapshot: current,
      versionLabel: '1.0.0', origin: RevisionOrigin.IMPORTED_CONFIRMED, exportEligible: true,
    });
    const draft = startNextRequirementDraft(current, base, 2n, now);
    const result = buildRequirementConfirmation(draft, frozen, now);
    expect(result.current.lifecycle).toBe(Lifecycle.CONFIRMED);
    expect(result.revision.previousRevision).toBe(base.name);
  });

  it('atomically prepares one next RobotModel revision and pointer', () => {
    const robot = create(RobotModelSchema, {
      name: 'robotModels/arm', uid: '00000000-0000-4000-8000-000000000005', displayName: 'Arm',
    });
    const first = appendRobotModelRevision(robot, undefined, 1, now);
    const previous = create(RobotModelRevisionSchema, first.revision);
    const second = appendRobotModelRevision(first.current, previous, 2, now);
    expect(first).toMatchObject({ versionSequence: 1, revision: { versionLabel: '1.0.0' } });
    expect(second).toMatchObject({ versionSequence: 2, revision: { versionLabel: '1.0.1', previousRevision: first.revision.name } });
    expect(second.current.currentRevision).toBe(second.revision.name);
  });
});
