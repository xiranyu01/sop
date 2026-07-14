import type {
  AppData,
  Customer,
  GlobalField,
  Material,
  MaterialStateRule,
  Requirement,
  RobotModel,
  Scene,
} from '../../src/types';
import type { AttachmentObjectStore } from '../../server/domain/attachmentObjectStore';

export type ApiRequest = {
  method: string;
  pathname: string;
  search?: string;
  body?: unknown;
  rawBody?: ArrayBuffer;
  authorization?: string | null;
  attachmentPublicBaseUrl?: string;
  auth?: { password?: string; requireConfigured?: boolean };
};

export type ApiResponse = { status: number; body: unknown; headers?: Record<string, string> };

/** Compatibility boundary removed after the canonical API cutover. */
export interface LegacyDataStore {
  readData(): Promise<AppData>;
  writeCustomers(customers: Customer[]): Promise<Customer[]>;
  writeMaterials(materials: Material[]): Promise<Material[]>;
  writeRobotModels(robotModels: RobotModel[]): Promise<RobotModel[]>;
  writeScenes(scenes: Scene[]): Promise<Scene[]>;
  writeRequirements(requirements: Requirement[]): Promise<Requirement[]>;
  writeGlobalFields(globalFields: GlobalField[]): Promise<GlobalField[]>;
  writeMaterialStateRules(materialStateRules: MaterialStateRule[]): Promise<MaterialStateRule[]>;
  writeExport(requirementId: string, version: string, yaml: string): Promise<string>;
}

export type LegacyApiStore = LegacyDataStore & Partial<AttachmentObjectStore>;

export function encodeRestDto<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

