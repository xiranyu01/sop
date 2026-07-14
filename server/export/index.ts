import type { CanonicalSnapshot } from '../domain/appStore';
import { ExportNotFoundError } from '../domain/errors';
import { buildExportBundle } from './bundle';
import { resolveExportClosure } from './closure';
import { serializeExportBundleYaml } from './yaml';

export function exportRequirementYaml(snapshot: CanonicalSnapshot, sourceId: string, versionLabel: string): string {
  const exists = snapshot.requirementRevisions.some((revision) =>
    revision.snapshot?.sourceId === sourceId && revision.versionLabel === versionLabel);
  if (!exists) throw new ExportNotFoundError(`找不到客户需求版本：${sourceId} v${versionLabel}`);
  return serializeExportBundleYaml(buildExportBundle(resolveExportClosure(snapshot, {
    kind: 'requirement', sourceId, versionLabel,
  })));
}

export function exportTaskSopYaml(
  snapshot: CanonicalSnapshot,
  sceneSourceId: string,
  subsceneCode: string,
  versionLabel: string,
): string {
  const candidates = snapshot.taskSopRevisions.filter((revision) => {
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
  return serializeExportBundleYaml(buildExportBundle(resolveExportClosure(snapshot, {
    kind: 'task_sop', sourceId, versionLabel,
  })));
}
