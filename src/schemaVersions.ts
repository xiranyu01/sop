import type { AppMetadata } from '../shared/transport/restDto';

export const appDataSchemaVersion = 'app_data_v0.1';
export const requirementYamlSchemaVersion = 'requirement_yaml_v0.11';
export const taskSopYamlSchemaVersion = 'task_sop_yaml_v0.5';

export const defaultAppMetadata: AppMetadata = {
  appDataSchemaVersion,
  requirementYamlSchemaVersion,
  taskSopYamlSchemaVersion,
};
