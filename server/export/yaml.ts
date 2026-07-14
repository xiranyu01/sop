import { toJson, type JsonValue } from '@bufbuild/protobuf';
import YAML from 'yaml';
import { FrozenExportContentSchema, type ExportBundle } from '../../gen/coscene/sop/export/v1alpha1/bundle_pb';
import { verifyExportBundle } from './codec';

const enumPrefixByField: Record<string, string> = {
  kind: 'ROOT_KIND_',
  legacyLifecycle: 'LIFECYCLE_',
  frequency: 'CHANGE_FREQUENCY_',
  priority: 'PRIORITY_',
  readiness: 'ANNOTATION_READINESS_',
  status: 'GLOBAL_FIELD_STATUS_',
  group: 'GLOBAL_FIELD_GROUP_',
};

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function enumToken(field: string | undefined, value: string): string {
  const prefix = field ? enumPrefixByField[field] : undefined;
  return prefix && value.startsWith(prefix) ? value.slice(prefix.length).toLowerCase() : value;
}

function yamlTree(value: JsonValue, field?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => yamlTree(item, field));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [snakeCase(key), yamlTree(item, key)]));
  }
  return typeof value === 'string' ? enumToken(field, value) : value;
}

export function serializeExportBundleYaml(bundle: ExportBundle): string {
  const content = verifyExportBundle(bundle).content!;
  const json = toJson(FrozenExportContentSchema, content, {
    alwaysEmitImplicit: true,
    enumAsInteger: false,
    useProtoFieldName: false,
  });
  const output = YAML.stringify(yamlTree(json), {
    aliasDuplicateObjects: false,
    lineWidth: 0,
  }).replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
  return output;
}
