import type {
  AppMetadata,
  ChangeFrequency,
  Customer,
  EntityStatus,
  GlobalField,
  GlobalFieldGroup,
  GlobalFieldStatus,
  Material,
  MaterialStateRule,
  OperationStep,
  Priority,
  Requirement,
  RequirementAttachment,
  RequirementVersion,
  RobotModel,
  Scene,
  Subscene,
  SubsceneVersion,
  TextItem,
} from '../../shared/transport/restDto';
import { defaultAppMetadata } from '../schemaVersions';

/**
 * Form-oriented projection of the canonical Proto domain.
 *
 * React owns these view models, while generated messages remain the internal
 * authority. The REST API currently serializes this projection so existing
 * forms can migrate without duplicating domain rules in the browser.
 */
export interface AppViewModel {
  metadata: AppMetadata;
  customers: Customer[];
  materials: Material[];
  robotModels: RobotModel[];
  scenes: Scene[];
  requirements: Requirement[];
  globalFields: GlobalField[];
  materialStateRules: MaterialStateRule[];
}

export type {
  ChangeFrequency,
  Customer,
  EntityStatus,
  GlobalField,
  GlobalFieldGroup,
  GlobalFieldStatus,
  Material,
  MaterialStateRule,
  OperationStep,
  Priority,
  Requirement,
  RequirementAttachment,
  RequirementVersion,
  RobotModel,
  Scene,
  Subscene,
  SubsceneVersion,
  TextItem,
};

export function createEmptyAppViewModel(): AppViewModel {
  return {
    metadata: { ...defaultAppMetadata },
    customers: [],
    materials: [],
    robotModels: [],
    scenes: [],
    requirements: [],
    globalFields: [],
    materialStateRules: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decodes and validates the canonical ProtoJSON envelope before projecting
 * generated messages into form-oriented view models.
 */
export async function decodeAppViewModel(value: unknown): Promise<AppViewModel> {
  if (!isRecord(value)) throw new Error('Invalid canonical app data envelope');
  const [{ decodeCanonicalSnapshot }, { projectCanonicalToRest }] = await Promise.all([
    import('../../server/domain/appStore'),
    import('../../server/domain/services/projection'),
  ]);
  const snapshot = decodeCanonicalSnapshot(JSON.stringify(value));
  return projectCanonicalToRest(snapshot);
}
