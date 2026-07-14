import { RootKind, type FrozenExportContent } from '../../gen/coscene/sop/export/v1alpha1/bundle_pb';

export type ExportBundleView = {
  rootKind: 'task_sop' | 'requirement';
  rootName: string;
  rootUid: string;
  revisionName: string;
  revisionUid: string;
  versionLabel: string;
  confirmationTime: string;
  rendererVersion: string;
  exportVersion: string;
  title: string;
  description?: string;
  attachmentNames: string[];
  taskSop?: NonNullable<FrozenExportContent['taskSops'][number]>;
  requirement?: NonNullable<FrozenExportContent['requirements'][number]>;
  content: FrozenExportContent;
};

function timestamp(value: FrozenExportContent['confirmationTime']): string {
  if (!value) throw new TypeError('Frozen export content is missing confirmation_time');
  const milliseconds = Number(value.seconds) * 1000 + Math.floor(value.nanos / 1_000_000);
  return new Date(milliseconds).toISOString();
}

export function exportBundleToView(content: FrozenExportContent): ExportBundleView {
  if (!content.root) throw new TypeError('Frozen export content is missing root');
  const attachmentNames = content.attachments.map((attachment) => attachment.filename);
  if (content.root.kind === RootKind.TASK_SOP) {
    const taskSop = content.taskSops.find((item) => item.ref === content.root!.ref);
    if (!taskSop) throw new TypeError(`Frozen TaskSop root is missing: ${content.root.ref}`);
    return {
      rootKind: 'task_sop', rootName: content.rootName, rootUid: content.rootUid,
      revisionName: content.revisionName, revisionUid: content.revisionUid,
      versionLabel: content.versionLabel, confirmationTime: timestamp(content.confirmationTime),
      rendererVersion: content.rendererVersion, exportVersion: content.exportVersion,
      title: taskSop.displayName, description: taskSop.description,
      attachmentNames, taskSop, content,
    };
  }
  if (content.root.kind === RootKind.REQUIREMENT) {
    const requirement = content.requirements.find((item) => item.ref === content.root!.ref);
    if (!requirement) throw new TypeError(`Frozen Requirement root is missing: ${content.root.ref}`);
    return {
      rootKind: 'requirement', rootName: content.rootName, rootUid: content.rootUid,
      revisionName: content.revisionName, revisionUid: content.revisionUid,
      versionLabel: content.versionLabel, confirmationTime: timestamp(content.confirmationTime),
      rendererVersion: content.rendererVersion, exportVersion: content.exportVersion,
      title: requirement.displayName, description: requirement.description,
      attachmentNames, requirement, content,
    };
  }
  throw new TypeError(`Unsupported frozen export root kind: ${content.root.kind}`);
}

