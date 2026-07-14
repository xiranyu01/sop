import type {
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

/**
 * Form-oriented projection of the canonical Proto domain.
 *
 * React owns these view models, while generated messages remain the internal
 * authority. The REST API currently serializes this projection so existing
 * forms can migrate without duplicating domain rules in the browser.
 */
export interface AppViewModel {
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
    customers: [],
    materials: [],
    robotModels: [],
    scenes: [],
    requirements: [],
    globalFields: [],
    materialStateRules: [],
  };
}
