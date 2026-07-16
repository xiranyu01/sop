import { ExportNotFoundError } from '../domain/errors';
import { buildExportBundle } from './bundle';
import { resolveExportClosure, type ExportClosureSource } from './closure';
import { serializeExportBundleYaml, type DomainYamlOptions } from './yaml';

export {
  canonicalFrozenContentProtoJson,
  decodeExportBundle,
  encodeExportBundle,
  measureFrozenExportContent,
  verifyExportBundle,
} from './codec';

function sourceYamlOptions(sourceRecords: ExportClosureSource): DomainYamlOptions {
  const revisions = [...sourceRecords.requirementRevisions, ...sourceRecords.taskSopRevisions];
  const byName = new Map(revisions.map((item) => [item.name, item]));
  const parentRevisionUids = new Map<string, string>();
  for (const revision of revisions) {
    const parent = revision.previousRevision ? byName.get(revision.previousRevision) : undefined;
    if (parent) parentRevisionUids.set(revision.name, parent.uid);
  }
  return { parentRevisionUids };
}

export function exportRequirementYaml(sourceRecords: ExportClosureSource, sourceId: string, versionLabel: string): string {
  const exists = sourceRecords.requirementRevisions.some((revision) =>
    revision.snapshot?.sourceId === sourceId && revision.versionLabel === versionLabel);
  if (!exists) throw new ExportNotFoundError(`找不到客户需求版本：${sourceId} v${versionLabel}`);
  return serializeExportBundleYaml(buildExportBundle(resolveExportClosure(sourceRecords, {
    kind: 'requirement', sourceId, versionLabel,
  })), sourceYamlOptions(sourceRecords));
}

export function exportTaskSopYaml(
  sourceRecords: ExportClosureSource,
  sceneSourceId: string,
  subsceneCode: string,
  versionLabel: string,
): string {
  const candidates = sourceRecords.taskSopRevisions.filter((revision) => {
    if (revision.versionLabel !== versionLabel || !revision.snapshot) return false;
    if (revision.snapshot.sourceId === `${sceneSourceId}-${subsceneCode}`) return true;
    if (revision.snapshot.legacySubsceneCode !== subsceneCode) return false;
    return revision.frozenDependencies?.scenes.some((scene) => scene.sourceId === sceneSourceId) ?? false;
  });
  if (candidates.length !== 1) {
    if (candidates.length === 0) throw new ExportNotFoundError(`找不到任务 SOP 版本：${sceneSourceId}/${subsceneCode} v${versionLabel}`);
    throw new ExportNotFoundError(`任务 SOP 版本定位不唯一：${sceneSourceId}/${subsceneCode} v${versionLabel}`);
  }
  const sourceId = candidates[0].snapshot!.sourceId || candidates[0].snapshot!.name.split('/').at(-1)!;
  return serializeExportBundleYaml(buildExportBundle(resolveExportClosure(sourceRecords, {
    kind: 'task_sop', sourceId, versionLabel,
  })), sourceYamlOptions(sourceRecords));
}
