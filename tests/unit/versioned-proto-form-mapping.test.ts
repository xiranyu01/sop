import { describe, expect, it } from 'vitest';
import customers from '../../data/customers.json';
import globalFields from '../../data/global-fields.json';
import materialStateRules from '../../data/material-state-rules.json';
import materials from '../../data/materials.json';
import metadata from '../../data/metadata.json';
import requirements from '../../data/requirements.json';
import robotModels from '../../data/robot-models.json';
import scenes from '../../data/scenes.json';
import { isFieldSet } from '@bufbuild/protobuf';
import { ProductionFlow } from '../../gen/coscene/sop/v1alpha1/common_pb';
import { ProductionItemSchema, RequirementSchema } from '../../gen/coscene/sop/v1alpha1/requirement_pb';
import { RobotModelSchema } from '../../gen/coscene/sop/v1alpha1/catalog_pb';
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

/**
 * The requirement form context exactly as `App.tsx#requirementContext` builds it:
 * `robotRevisionNameById` keyed by the catalog robot's `id`, which is the
 * RobotModel **sourceId** — while decoding emits the pinned revision's **root
 * tail**. The two coincide only for slug-safe sourceIds. Keying this map any
 * other way (as this file used to, off `editable.robotModelId`) puts the harness
 * in an id space production never sees, and every id-space defect passes.
 */
function appRequirementContext(prepared: ReturnType<typeof prepareRepositoryData>) {
  const robotRevisionNameById = new Map<string, string>();
  for (const current of prepared.currents) {
    if (!current.protoSchema.endsWith('.RobotModel')) continue;
    const robot = fromDomainJson(RobotModelSchema, JSON.parse(current.protoJson));
    const id = robot.sourceId || robot.name.split('/').at(-1) || '';
    if (id && robot.currentRevision) robotRevisionNameById.set(id, robot.currentRevision);
  }
  return { robotRevisionNameById };
}

function requirementFixture() {
  const prepared = prepareRepositoryData(structuredClone(fixture));
  const current = prepared.currents.find((item) => item.protoSchema.endsWith('.Requirement'));
  expect(current).toBeDefined();
  const resource = JSON.parse(current!.protoJson) as {
    spec: { robotModelRevision: string; productionItems: Array<Record<string, unknown>> };
  };
  const context = {
    ...appRequirementContext(prepared),
    taskRevisionName: (candidate: { id?: string }) => resource.spec.productionItems
      .find((stored) => stored.id === candidate.id)?.taskSopRevision as string | undefined,
  };
  const decode = () => {
    const versions = decodeRequirementVersions(resource as never, revisionDetails(prepared, current!.name), context);
    return versions.find((item) => item.status === 'draft' && !revisionIsCheckpoint(item)) ?? versions.at(-1)!;
  };
  return { prepared, current: current!, resource, context, decode };
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

  it('carries a per-item robot and production flow in both directions', () => {
    const prepared = prepareRepositoryData(structuredClone(fixture));
    const current = prepared.currents.find((item) => item.protoSchema.endsWith('.Requirement'));
    expect(current).toBeDefined();
    const resource = JSON.parse(current!.protoJson);
    const specRobotRevision: string = resource.spec.robotModelRevision;
    const itemRobotRevision = 'robotModels/robot-general-dual-arm/revisions/current';
    expect(itemRobotRevision).not.toBe(specRobotRevision);
    resource.spec.productionItems[0] = {
      ...resource.spec.productionItems[0],
      robotModelRevision: itemRobotRevision,
      productionFlow: 'PRODUCTION_FLOW_COLLECT_QA1_ANNOTATE_QA2',
    };

    const versions = decodeRequirementVersions(resource, revisionDetails(prepared, current!.name));
    const editable = versions.find((item) => item.status === 'draft' && !revisionIsCheckpoint(item))
      ?? versions.at(-1)!;
    const item = editable.selectedSubscenes[0];
    expect(editable.robotModelId).toBe('robot-mqorua3y-c7w6nr-50496263');
    expect(item.robotModelId).toBe('robot-general-dual-arm');
    expect(item.productionFlow).toBe('collect_qa1_annotate_qa2');

    const encoded = encodeRequirementVersion(editable, resource, {
      robotRevisionNameById: new Map([
        [editable.robotModelId, specRobotRevision],
        ['robot-general-dual-arm', itemRobotRevision],
      ]),
      taskRevisionName: (candidate) => resource.spec.productionItems
        .find((stored: { id: string }) => stored.id === candidate.id)?.taskSopRevision,
    });
    const updated = fromDomainJson(RequirementSchema, encoded);
    expect(updated.spec?.robotModelRevision).toBe(specRobotRevision);
    expect(updated.spec?.productionItems[0]?.robotModelRevision).toBe(itemRobotRevision);
    expect(updated.spec?.productionItems[0]?.productionFlow).toBe(ProductionFlow.COLLECT_QA1_ANNOTATE_QA2);
  });

  it('re-encodes an item that decoded with no production flow as an absent field', () => {
    const prepared = prepareRepositoryData(structuredClone(fixture));
    const current = prepared.currents.find((item) => item.protoSchema.endsWith('.Requirement'));
    expect(current).toBeDefined();
    const resource = JSON.parse(current!.protoJson);
    expect(resource.spec.productionItems[0].productionFlow).toBeUndefined();

    const versions = decodeRequirementVersions(resource, revisionDetails(prepared, current!.name));
    const editable = versions.find((item) => item.status === 'draft' && !revisionIsCheckpoint(item))
      ?? versions.at(-1)!;
    expect(editable.selectedSubscenes[0].productionFlow).toBeUndefined();

    const encoded = encodeRequirementVersion(editable, resource, {
      robotRevisionNameById: new Map([[editable.robotModelId, resource.spec.robotModelRevision]]),
      taskRevisionName: (candidate) => resource.spec.productionItems
        .find((stored: { id: string }) => stored.id === candidate.id)?.taskSopRevision,
    });
    // Absence is the signal that a record predates the field, so the key must be
    // gone from the stored ProtoJSON — an explicit UNSPECIFIED would not do.
    const storedItem = (encoded as { spec: { productionItems: Array<Record<string, unknown>> } })
      .spec.productionItems[0];
    expect(Object.keys(storedItem)).not.toContain('productionFlow');
    expect(isFieldSet(
      fromDomainJson(RequirementSchema, encoded).spec!.productionItems[0],
      ProductionItemSchema.field.productionFlow,
    )).toBe(false);
  });

  it('pins explicit per-item robot selections across both robot id spaces', () => {
    const { resource, context, decode } = requirementFixture();
    const editable = decode();
    // The precondition that makes this test worth anything: the decoded id is the
    // revision root tail and the context map is keyed by the catalog sourceId, and
    // for this robot they differ. Without it the selection would work by coincidence.
    expect(editable.robotModelId).toBe('robot-mqorua3y-c7w6nr-50496263');
    expect(context.robotRevisionNameById.has(editable.robotModelId)).toBe(false);
    expect(context.robotRevisionNameById.has('robot_mqorua3y_c7w6nr')).toBe(true);
    expect(editable.selectedSubscenes.length).toBeGreaterThan(0);

    // A freshly added item has no stored counterpart, so the encoder's "keep the
    // previous revision when the id is unchanged" fallback cannot mask the id-space
    // miss — this is the row the reproduction saw persist as ''.
    const items = [
      ...editable.selectedSubscenes,
      { title: '新增采集任务', description: '', sceneName: '', targetDurationHours: 0, targetCollectionCount: 0 },
    ];
    // Selecting this same robot on every row is still a valid per-item edit. A miss
    // here used to persist '' — an ERASE that silently demotes every item to an inheritor.
    const updatedSelection = {
      ...editable,
      selectedSubscenes: items.map((item) => ({ ...item, robotModelId: editable.robotModelId })),
    };
    const updated = fromDomainJson(RequirementSchema, encodeRequirementVersion(updatedSelection, resource as never, context));
    expect(updated.spec?.productionItems.map((item) => item.robotModelRevision))
      .toEqual(updated.spec?.productionItems.map(() => resource.spec.robotModelRevision));
  });

  it('refuses to save an item robot this build cannot resolve instead of erasing it', () => {
    const { resource, context, decode } = requirementFixture();
    const editable = decode();
    const broken = {
      ...editable,
      selectedSubscenes: editable.selectedSubscenes.map((item, index) => (index === 0
        ? { ...item, robotModelId: 'robot-that-does-not-exist' }
        : item)),
    };
    expect(() => encodeRequirementVersion(broken, resource as never, context))
      .toThrow(/robot-that-does-not-exist/);
  });

  it('carries a production flow this build does not know through an unrelated edit', () => {
    const { resource, context, decode } = requirementFixture();
    // A newer writer's enum value. proto3 enums are open, so an older reader must
    // hand it back unchanged rather than collapse it to "no flow".
    resource.spec.productionItems[0].productionFlow = 7;
    const editable = decode();
    expect(editable.selectedSubscenes[0].productionFlow).toBeUndefined();

    const encoded = encodeRequirementVersion({ ...editable, title: '改个标题' }, resource as never, context);
    const stored = (encoded as { spec: { productionItems: Array<Record<string, unknown>> } })
      .spec.productionItems[0];
    expect(stored.productionFlow).toBe(7);
    expect(fromDomainJson(RequirementSchema, encoded).spec!.productionItems[0]!.productionFlow).toBe(7);
  });

  it('keeps an explicitly stored UNSPECIFIED flow present through a round trip', () => {
    const { resource, context, decode } = requirementFixture();
    resource.spec.productionItems[0].productionFlow = 'PRODUCTION_FLOW_UNSPECIFIED';
    const editable = decode();
    expect(editable.selectedSubscenes[0].productionFlow).toBeUndefined();

    const encoded = encodeRequirementVersion(editable, resource as never, context);
    const storedItem = (encoded as { spec: { productionItems: Array<Record<string, unknown>> } })
      .spec.productionItems[0];
    // Three states, not two: an explicit UNSPECIFIED is not the same record as one
    // that predates the field, and the exporter branches on the difference.
    expect(Object.keys(storedItem)).toContain('productionFlow');
    expect(isFieldSet(
      fromDomainJson(RequirementSchema, encoded).spec!.productionItems[0],
      ProductionItemSchema.field.productionFlow,
    )).toBe(true);
  });

  it('drops the carried raw flow as soon as the form authors one', () => {
    const { resource, context, decode } = requirementFixture();
    resource.spec.productionItems[0].productionFlow = 7;
    const editable = decode();
    const chosen = {
      ...editable,
      selectedSubscenes: editable.selectedSubscenes.map((item, index) => (index === 0
        ? { ...item, productionFlow: 'collect' as const, productionFlowRawValue: undefined }
        : item)),
    };
    const updated = fromDomainJson(RequirementSchema, encodeRequirementVersion(chosen, resource as never, context));
    expect(updated.spec?.productionItems[0]?.productionFlow).toBe(ProductionFlow.COLLECT);
  });
});
