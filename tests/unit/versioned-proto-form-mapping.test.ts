import { describe, expect, it } from 'vitest';
import customers from '../../data/customers.json';
import globalFields from '../../data/global-fields.json';
import materialStateRules from '../../data/material-state-rules.json';
import materials from '../../data/materials.json';
import metadata from '../../data/metadata.json';
import requirements from '../../data/requirements.json';
import robotModels from '../../data/robot-models.json';
import scenes from '../../data/scenes.json';
import { RequirementSchema } from '../../gen/coscene/sop/v1alpha1/requirement_pb';
import { TaskSopSchema } from '../../gen/coscene/sop/v1alpha1/task_sop_pb';
import { fromDomainJson } from '../../shared/domain/codec';
import type { AppData } from '../../shared/transport/restDto';
import type { RevisionDetail } from '../../shared/transport/resourceDto';
import { prepareRepositoryData } from '../../server/bootstrap/repositoryData';
import {
  decodeRequirementVersions,
  decodeTaskSopVersions,
  encodeRequirementVersion,
  encodeTaskSopVersion,
  revisionIsCheckpoint,
} from '../../src/domain/versionedProtoFormMapping';

const fixture = { metadata, customers, materials, robotModels, scenes, requirements, globalFields, materialStateRules } as AppData;

function revisionDetails(
  prepared: ReturnType<typeof prepareRepositoryData>,
  ownerName: string,
): RevisionDetail[] {
  return prepared.revisions.filter((item) => item.ownerName === ownerName).map((item) => {
    const resource = JSON.parse(item.revisionProtoJson) as Record<string, unknown>;
    return {
      name: item.name,
      uid: String(resource.uid || ''),
      versionLabel: item.versionLabel,
      origin: item.revisionOrigin || 'IMPORTED_LEGACY',
      lifecycle: item.lifecycle || 'DRAFT',
      exportEligible: Boolean(item.exportEligible),
      sourceVersionId: typeof resource.sourceVersionId === 'string' ? resource.sourceVersionId : undefined,
      ownerName,
      kind: item.protoSchema.endsWith('.TaskSopRevision') ? 'TASK_SOP_REVISION' : 'REQUIREMENT_REVISION',
      previousRevisionName: typeof resource.previousRevision === 'string' ? resource.previousRevision : undefined,
      resource: resource as never,
    };
  });
}

describe('versioned Proto form mapping', () => {
  it('keeps imported TaskSop draft checkpoints read-only and encodes only the editable current draft', () => {
    const prepared = prepareRepositoryData(structuredClone(fixture));
    const current = prepared.currents.find((item) => item.protoSchema.endsWith('.TaskSop') && item.candidateVersionLabel);
    expect(current).toBeDefined();
    const resource = JSON.parse(current!.protoJson);
    const sourceObject = resource.spec.objects[0];
    resource.spec.objectStates = {
      ...resource.spec.objectStates,
      duringOperation: [{
        objectId: sourceObject.id,
        parameters: [{
          name: 'door_open_angle',
          displayName: '微波炉门打开角度',
          valueType: 'number',
          constraints: ['需要满足安全要求'],
        }],
      }],
    };
    resource.spec.randomization = {
      ...resource.spec.randomization,
      objectDuringOperation: [{
        objectIds: [sourceObject.id],
        parameterNames: ['door_open_angle'],
      }],
    };
    sourceObject.roles = ['primary'];
    sourceObject.attributes = [{ key: 'finish', values: ['matte', 'glossy'] }];
    sourceObject.images = ['attachments/object-photo'];
    sourceObject.materialDescriptor = {
      ...sourceObject.materialDescriptor,
      size: '20 cm',
      weight: '150 g',
    };
    const versions = decodeTaskSopVersions(resource, revisionDetails(prepared, current!.name));
    const checkpoints = versions.filter(revisionIsCheckpoint);
    const draft = versions.find((item) => item.status === 'draft' && !revisionIsCheckpoint(item));

    expect(checkpoints.length).toBeGreaterThan(0);
    expect(draft).toBeDefined();
    const encoded = encodeTaskSopVersion({ ...draft!, description: 'resource-scoped edit' }, resource);
    const message = fromDomainJson(TaskSopSchema, encoded);
    expect(message.description).toBe('resource-scoped edit');
    expect(message.name).toBe(current!.name);
    expect(message.candidateVersionLabel).toBe(draft!.version);
    expect(message.spec?.objects.find((item) => item.id === sourceObject.id)).toMatchObject({
      roles: ['primary'],
      attributes: [{ key: 'finish', values: ['matte', 'glossy'] }],
      images: ['attachments/object-photo'],
      materialDescriptor: {
        size: '20 cm',
        weight: '150 g',
      },
    });
    expect(draft!.objectStates.duringOperation).toBeUndefined();
    expect(draft!.randomization.materialStateDuringOperation).toBeUndefined();
    expect(message.spec?.objectStates?.duringOperation).toEqual([]);
    expect(message.spec?.randomization?.objectDuringOperation).toEqual([]);

    const attachmentName = 'attachments/uploaded-1';
    const withAttachment = { ...resource, attachments: [attachmentName] };
    const [resolved] = decodeTaskSopVersions(withAttachment, [], {
      attachmentByName: (name) => ({
        id: name.split('/').at(-1)!, name: 'photo.png', size: 4, contentType: 'image/png',
        storageKey: 'https://cdn.test/photo.png', uploadedAt: '2026-07-14T00:00:00.000Z',
      }),
      attachmentNameById: new Map([['uploaded-1', attachmentName]]),
    });
    expect(resolved.attachments?.[0]).toMatchObject({ id: 'uploaded-1', name: 'photo.png' });
    expect(fromDomainJson(TaskSopSchema, encodeTaskSopVersion(resolved, withAttachment, {
      attachmentNameById: new Map([['uploaded-1', attachmentName]]),
    })).attachments).toEqual([attachmentName]);
  });

  it('round-trips one Requirement without loading a site-wide document', () => {
    const prepared = prepareRepositoryData(structuredClone(fixture));
    const current = prepared.currents.find((item) => item.protoSchema.endsWith('.Requirement'));
    expect(current).toBeDefined();
    const resource = JSON.parse(current!.protoJson);
    resource.spec.globalRequirements = {
      ...resource.spec.globalRequirements,
      topics: [{ topicId: 'camera', constraints: ['30fps', 'color'] }],
    };
    resource.spec.aggregateTarget = { collectionCount: '2' };
    const message = fromDomainJson(RequirementSchema, resource);
    const versions = decodeRequirementVersions(resource, revisionDetails(prepared, current!.name));
    const editable = versions.find((item) => item.status === 'draft' && !revisionIsCheckpoint(item))
      ?? versions.at(-1)!;
    const encoded = encodeRequirementVersion({ ...editable, title: '单资源需求编辑' }, resource, {
      customerNameById: new Map([[editable.customerId, message.spec?.customer || '']]),
      robotRevisionNameById: new Map([[editable.robotModelId, message.spec?.robotModelRevision || '']]),
      taskRevisionName: (item) => message.spec?.productionItems.find((candidate) => candidate.id === item.id)?.taskSopRevision,
    });
    const updated = fromDomainJson(RequirementSchema, encoded);

    expect(updated.name).toBe(current!.name);
    expect(updated.displayName).toBe('单资源需求编辑');
    expect(updated.spec?.customer).toBe(message.spec?.customer);
    expect(updated.spec?.productionItems.map((item) => item.taskSopRevision))
      .toEqual(message.spec?.productionItems.map((item) => item.taskSopRevision));
    expect(updated.spec?.globalRequirements?.topics).toEqual(message.spec?.globalRequirements?.topics);
    expect(updated.spec?.aggregateTarget?.collectionCount).toBe(2n);
    expect(updated.spec?.aggregateTarget?.duration).toBeUndefined();
  });
});
