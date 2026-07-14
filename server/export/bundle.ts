import { create } from '@bufbuild/protobuf';
import {
  ExportBundleSchema,
  FrozenExportContentSchema,
  RootKind,
  type ExportBundle,
  type FrozenExportContent,
  type SourceIdentity,
} from '../../gen/coscene/sop/export/v1alpha1/bundle_pb';
import type { CanonicalSnapshot } from '../domain/appStore';
import { CanonicalDataError } from '../domain/errors';
import { bundleRef, type ExportClosure } from './closure';
import {
  exportSchemaVersion,
  frozenExportFormat,
  measureFrozenExportContent,
  sealedBundleFormat,
} from './codec';

export const rendererVersion = 'sop-pdf-v1' as const;
export const yamlExportVersion = 'sop-yaml-v1' as const;

function source(value: { name: string; uid: string; sourceId?: string }): SourceIdentity {
  return {
    $typeName: 'coscene.sop.export.v1alpha1.SourceIdentity',
    resourceName: value.name,
    uid: value.uid,
    sourceId: value.sourceId,
  };
}

function revision(value: { name: string; uid: string; versionLabel: string; sourceVersionId?: string }) {
  return {
    revisionName: value.name,
    revisionUid: value.uid,
    versionLabel: value.versionLabel,
    sourceVersionId: value.sourceVersionId,
  };
}

function bindingMap(closure: ExportClosure): Map<string, string> {
  return new Map([
    ...closure.requirements.map((item) => [item.name, bundleRef('requirement', item.name)] as const),
    ...closure.taskSops.map((item) => [item.name, bundleRef('task-sop', item.name)] as const),
    ...closure.robotModelRevisions.map((item) => [item.name, bundleRef('robot-model-revision', item.name)] as const),
    ...closure.customers.map((item) => [item.name, bundleRef('customer', item.name)] as const),
    ...closure.materials.map((item) => [item.name, bundleRef('material', item.name)] as const),
    ...closure.scenes.map((item) => [item.name, bundleRef('scene', item.name)] as const),
    ...closure.globalFields.map((item) => [item.name, bundleRef('global-field', item.name)] as const),
    ...closure.materialStateRules.map((item) => [item.name, bundleRef('material-state-rule', item.name)] as const),
    ...closure.attachments.map((item) => [item.name, bundleRef('attachment', item.name)] as const),
  ]);
}

function date(value?: { year: number; month: number; day: number }): string | undefined {
  if (!value) return undefined;
  return `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

function duration(value?: { seconds: bigint; nanos: number }): string | undefined {
  if (!value) return undefined;
  if (value.seconds < 0n || value.nanos < 0) throw new CanonicalDataError('导出时长不能为负数');
  const hours = value.seconds / 3600n;
  const minutes = (value.seconds % 3600n) / 60n;
  const seconds = value.seconds % 60n;
  const fraction = value.nanos ? `.${String(value.nanos).padStart(9, '0').replace(/0+$/, '')}` : '';
  const parts = [
    hours ? `${hours}H` : '',
    minutes ? `${minutes}M` : '',
    seconds || fraction ? `${seconds}${fraction}S` : '',
  ].join('');
  return `PT${parts || '0S'}`;
}

function workload(value?: { duration?: { seconds: bigint; nanos: number }; collectionCount?: bigint }) {
  return value ? { duration: duration(value.duration), collectionCount: value.collectionCount } : undefined;
}

function taskSpec(
  spec: NonNullable<CanonicalSnapshot['taskSopRevisions'][number]['snapshot']>['spec'],
  refs: Map<string, string>,
) {
  const location = (value: NonNullable<NonNullable<typeof spec>['objectStates']>['initial'][number]['allowedLocations'][number]) => ({
    displayName: value.displayName,
    referencePath: value.referencePath,
    supportSurface: value.supportSurface,
    regions: value.regions,
    poses: value.poses,
    forms: value.forms,
    parameters: value.parameters,
    constraints: value.constraints,
    collectorInstruction: value.collectorInstruction,
    exampleAttachmentRefs: value.exampleImages.map((name) => refs.get(name)!),
  });
  return {
    objects: spec?.objects.map((object) => ({
      id: object.id,
      displayName: object.displayName,
      materialRef: object.material ? refs.get(object.material) : undefined,
      quantity: object.quantity,
      roles: object.roles,
      attributes: object.attributes,
      attachmentRefs: object.images.map((name) => refs.get(name)!),
      materialDescriptor: object.materialDescriptor,
    })),
    robotState: spec?.robotState,
    objectStates: spec?.objectStates ? {
      initial: spec.objectStates.initial.map((state) => ({
        objectId: state.objectId,
        allowedLocations: state.allowedLocations.map(location),
      })),
      target: spec.objectStates.target.map((state) => ({
        objectId: state.objectId,
        requiredLocation: state.requiredLocation ? location(state.requiredLocation) : undefined,
      })),
      duringOperation: spec.objectStates.duringOperation,
    } : undefined,
    randomization: spec?.randomization ? {
      robotInitialState: spec.randomization.robotInitialState,
      objectInitialStates: spec.randomization.objectInitialStates.map((rule) => ({
        objectIds: rule.objectIds,
        change: rule.change,
        fields: rule.fields,
        collectorInstruction: rule.collectorInstruction,
        constraints: rule.constraints,
        exampleAttachmentRefs: rule.exampleImages.map((name) => refs.get(name)!),
        locations: rule.locations,
        poses: rule.poses,
        forms: rule.forms,
      })),
      objectDuringOperation: spec.randomization.objectDuringOperation,
    } : undefined,
    collection: spec?.collection,
    annotation: spec?.annotation,
    expectedDuration: duration(spec?.expectedDuration),
    robotOperationRequirements: spec?.robotOperationRequirements,
    robotInitialRandomizationRequirements: spec?.robotInitialRandomizationRequirements,
    legacyRandomizationFrequency: spec?.legacyRandomizationFrequency,
    materialStateRuleRefs: spec?.materialStateRules.map((rule) => refs.get(rule.name)!),
  };
}

function rootRevision(closure: ExportClosure) {
  const revision = closure.root.kind === 'requirement'
    ? closure.requirements.find((item) => bundleRef('requirement', item.name) === closure.rootRef)
    : closure.taskSops.find((item) => bundleRef('task-sop', item.name) === closure.rootRef);
  if (!revision?.snapshot) throw new CanonicalDataError('导出闭包缺少根版本');
  if (!revision.uid) throw new CanonicalDataError(`导出根版本缺少 UID：${revision.name}`);
  if (!revision.createTime) throw new CanonicalDataError(`导出根版本缺少确认时间：${revision.name}`);
  return revision;
}

export function buildFrozenExportContent(closure: ExportClosure): FrozenExportContent {
  const refs = bindingMap(closure);
  const root = rootRevision(closure);
  return create(FrozenExportContentSchema, {
    format: frozenExportFormat,
    schemaVersion: exportSchemaVersion,
    root: {
      kind: closure.root.kind === 'requirement' ? RootKind.REQUIREMENT : RootKind.TASK_SOP,
      ref: closure.rootRef,
    },
    rootName: root.snapshot!.name,
    rootUid: root.snapshot!.uid,
    revisionName: root.name,
    revisionUid: root.uid,
    versionLabel: root.versionLabel,
    confirmationTime: root.createTime,
    rendererVersion,
    exportVersion: yamlExportVersion,
    requirements: closure.requirements.map((item) => {
      const snapshot = item.snapshot!;
      const spec = snapshot.spec!;
      return {
        ref: refs.get(item.name)!,
        source: source(snapshot),
        revision: revision(item),
        displayName: snapshot.displayName,
        description: snapshot.description,
        spec: {
          customerRef: refs.get(spec.customer)!,
          robotModelRevisionRef: refs.get(spec.robotModelRevision)!,
          projectDisplayName: spec.projectDisplayName,
          businessGoal: spec.businessGoal,
          globalRequirements: spec.globalRequirements,
          delivery: spec.delivery,
          annotation: spec.annotation,
          qualityInspection: spec.qualityInspection,
          productionItems: spec.productionItems.map((production) => ({
            id: production.id,
            displayName: production.displayName,
            description: production.description,
            taskSopRef: refs.get(production.taskSopRevision)!,
            target: workload(production.target),
            legacySceneName: production.legacySceneName,
            legacySubsceneCode: production.legacySubsceneCode,
            legacySubsceneName: production.legacySubsceneName,
            legacyVersionLabel: production.legacyVersionLabel,
            legacyVersionId: production.legacyVersionId,
            legacyLifecycle: production.legacyLifecycle,
          })),
          priority: spec.priority,
          aggregateTarget: workload(spec.aggregateTarget),
          requestedSceneNames: spec.requestedSceneNames,
          sourceUri: spec.sourceUri,
          deadline: date(spec.deadline),
          attachmentNotes: spec.attachmentNotes,
          extraTopicRequirementsText: spec.extraTopicRequirementsText,
        },
        attachmentRefs: snapshot.attachments.map((name) => refs.get(name)!),
      };
    }),
    taskSops: closure.taskSops.map((item) => {
      const snapshot = item.snapshot!;
      const spec = snapshot.spec!;
      return {
        ref: refs.get(item.name)!,
        source: source(snapshot),
        revision: revision(item),
        displayName: snapshot.displayName,
        description: snapshot.description,
        sceneRef: refs.get(snapshot.scene)!,
        spec: taskSpec(spec, refs),
        attachmentRefs: snapshot.attachments.map((name) => refs.get(name)!),
        referenceUris: snapshot.referenceUris,
        referenceAttachments: snapshot.referenceAttachments,
      };
    }),
    customers: closure.customers.map((item) => ({
      ref: refs.get(item.name)!, source: source(item), displayName: item.displayName,
      primaryContact: item.primaryContact, notes: item.notes,
    })),
    robotModelRevisions: closure.robotModelRevisions.map((item) => ({
      ref: refs.get(item.name)!, source: source(item.snapshot!), revision: revision(item),
      displayName: item.snapshot!.displayName, manufacturer: item.snapshot!.manufacturer,
      modelCode: item.snapshot!.modelCode, endEffector: item.snapshot!.endEffector,
      topics: item.snapshot!.topics, extraTopicRequirements: item.snapshot!.extraTopicRequirements,
    })),
    materials: closure.materials.map((item) => ({
      ref: refs.get(item.name)!, source: source(item), displayName: item.displayName,
      sku: item.sku, category: item.category, colors: item.colors, compositions: item.compositions,
      packaging: item.packaging, size: item.size, weight: item.weight,
      attachmentRefs: item.images.map((name) => refs.get(name)!),
    })),
    scenes: closure.scenes.map((item) => ({
      ref: refs.get(item.name)!, source: source(item), displayName: item.displayName, description: item.description,
    })),
    globalFields: closure.globalFields.map((item) => ({
      ref: refs.get(item.name)!, source: source(item), group: item.group, label: item.label,
      value: item.value, category: item.category, description: item.description, status: item.status,
    })),
    materialStateRules: closure.materialStateRules.map((item) => ({
      ref: refs.get(item.name)!, source: source(item), materialType: item.materialType,
      primaryReferences: item.primaryReferences, primaryRelativePositions: item.primaryRelativePositions,
      supportSurfaces: item.supportSurfaces, regions: item.regions, secondaryReferences: item.secondaryReferences,
      secondaryRelativePositions: item.secondaryRelativePositions, poses: item.poses, forms: item.forms, parameters: item.parameters,
    })),
    attachments: closure.attachments.map((item) => ({
      ref: refs.get(item.name)!, source: source(item), filename: item.filename, mediaType: item.mediaType,
      sizeBytes: item.sizeBytes, publicUri: item.uri, sha256: item.sha256,
    })),
  });
}

export function sealExportContent(content: FrozenExportContent): ExportBundle {
  const measured = measureFrozenExportContent(content);
  return create(ExportBundleSchema, {
    format: sealedBundleFormat,
    schemaVersion: exportSchemaVersion,
    content,
    contentSha256: measured.contentSha256,
    contentSizeBytes: measured.contentSizeBytes,
  });
}

export function buildExportBundle(closure: ExportClosure): ExportBundle {
  return sealExportContent(buildFrozenExportContent(closure));
}
