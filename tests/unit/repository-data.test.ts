import customers from '../../data/customers.json';
import globalFields from '../../data/global-fields.json';
import materialStateRules from '../../data/material-state-rules.json';
import materials from '../../data/materials.json';
import metadata from '../../data/metadata.json';
import requirements from '../../data/requirements.json';
import robotModels from '../../data/robot-models.json';
import scenes from '../../data/scenes.json';
import { describe, expect, it } from 'vitest';
import { RevisionOrigin } from '../../gen/coscene/sop/v1alpha1/common_pb';
import { fromDomainJsonString } from '../../shared/domain/codec';
import type { AppData } from '../../shared/transport/restDto';
import { prepareRepositoryData } from '../../server/bootstrap/repositoryData';
import { TaskSopRevisionSchema, TaskSopSchema } from '../../gen/coscene/sop/v1alpha1/task_sop_pb';

const fixtures = {
  metadata,
  customers,
  materials,
  robotModels,
  scenes,
  requirements,
  globalFields,
  materialStateRules,
} as AppData;

describe('repository fixture preparation', () => {
  it('is deterministic and emits only independent persistence records', () => {
    const first = prepareRepositoryData(structuredClone(fixtures));
    const second = prepareRepositoryData(structuredClone(fixtures));
    expect(second).toEqual(first);
    expect(first.datasetDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.catalogs.length).toBeGreaterThan(0);
    expect(first.currents.length).toBeGreaterThan(0);
    expect(JSON.stringify(first)).not.toContain('CanonicalSnapshot');
  });

  it('keeps the newest TaskSop draft editable and every older draft as an ineligible checkpoint', () => {
    const prepared = prepareRepositoryData(structuredClone(fixtures));
    const currentRecord = prepared.currents.find((item) => {
      if (item.protoSchema !== TaskSopSchema.typeName) return false;
      return fromDomainJsonString(TaskSopSchema, item.protoJson).sourceId === 'scene-home-NO.001';
    });
    expect(currentRecord).toBeDefined();
    const current = fromDomainJsonString(TaskSopSchema, currentRecord!.protoJson);
    expect(current.candidateVersionLabel).toBe('0.0.5');
    expect(current.candidateSourceVersionId).toBeUndefined();

    const history = prepared.revisions
      .filter((item) => item.ownerName === current.name && item.protoSchema === TaskSopRevisionSchema.typeName)
      .map((item) => fromDomainJsonString(TaskSopRevisionSchema, item.revisionProtoJson));
    const checkpoints = history.filter((item) => item.origin === RevisionOrigin.IMPORTED_DRAFT_CHECKPOINT);
    const confirmed = history.filter((item) => item.origin === RevisionOrigin.IMPORTED_CONFIRMED);
    expect(checkpoints.map((item) => item.versionLabel).sort()).toEqual(['0.0.3', '0.0.4']);
    expect(checkpoints.every((item) => !item.exportEligible)).toBe(true);
    expect(confirmed).toHaveLength(2);
    expect(prepared.bundles.filter((item) => confirmed.some((revision) => revision.name === item.rootRevisionName))).toHaveLength(2);
    expect(prepared.bundles.some((item) => checkpoints.some((revision) => revision.name === item.rootRevisionName))).toBe(false);
  });
});
