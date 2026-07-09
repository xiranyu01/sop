import type { AppMetadata } from './types';

export const appDataSchemaVersion = 'app_data_v0.1';
export const requirementYamlSchemaVersion = 'requirement_yaml_v0.4';
export const taskSopYamlSchemaVersion = 'task_sop_yaml_v0.2';

export const defaultAppMetadata: AppMetadata = {
  appDataSchemaVersion,
  requirementYamlSchemaVersion,
  taskSopYamlSchemaVersion,
};
