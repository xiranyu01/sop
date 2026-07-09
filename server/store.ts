import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultAppMetadata } from '../src/schemaVersions';
import type { AppData, AppMetadata, Customer, GlobalField, Material, MaterialStateRule, Requirement, RobotModel, Scene } from '../src/types';
import type { AppStore } from './api';

const rootDir = process.cwd();
const dataDir = path.join(rootDir, 'data');
const uploadsDir = path.join(rootDir, 'uploads');

const files = {
  metadata: path.join(dataDir, 'metadata.json'),
  customers: path.join(dataDir, 'customers.json'),
  materials: path.join(dataDir, 'materials.json'),
  robotModels: path.join(dataDir, 'robot-models.json'),
  scenes: path.join(dataDir, 'scenes.json'),
  requirements: path.join(dataDir, 'requirements.json'),
  globalFields: path.join(dataDir, 'global-fields.json'),
  materialStateRules: path.join(dataDir, 'material-state-rules.json'),
};

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(file, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeJson<T>(file: string, data: T): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

export async function readData(): Promise<AppData> {
  const [metadata, customers, materials, robotModels, scenes, requirements, globalFields, materialStateRules] = await Promise.all([
    readJson<AppMetadata>(files.metadata, defaultAppMetadata),
    readJson<Customer[]>(files.customers, []),
    readJson<Material[]>(files.materials, []),
    readJson<RobotModel[]>(files.robotModels, []),
    readJson<Scene[]>(files.scenes, []),
    readJson<Requirement[]>(files.requirements, []),
    readJson<GlobalField[]>(files.globalFields, []),
    readJson<MaterialStateRule[]>(files.materialStateRules, []),
  ]);

  return { metadata, customers, materials, robotModels, scenes, requirements, globalFields, materialStateRules };
}

export async function writeCustomers(customers: Customer[]): Promise<Customer[]> {
  await writeJson(files.customers, customers);
  return customers;
}

export async function writeMaterials(materials: Material[]): Promise<Material[]> {
  await writeJson(files.materials, materials);
  return materials;
}

export async function writeRobotModels(robotModels: RobotModel[]): Promise<RobotModel[]> {
  await writeJson(files.robotModels, robotModels);
  return robotModels;
}

export async function writeScenes(scenes: Scene[]): Promise<Scene[]> {
  await writeJson(files.scenes, scenes);
  return scenes;
}

export async function writeRequirements(requirements: Requirement[]): Promise<Requirement[]> {
  await writeJson(files.requirements, requirements);
  return requirements;
}

export async function writeGlobalFields(globalFields: GlobalField[]): Promise<GlobalField[]> {
  await writeJson(files.globalFields, globalFields);
  return globalFields;
}

export async function writeMaterialStateRules(materialStateRules: MaterialStateRule[]): Promise<MaterialStateRule[]> {
  await writeJson(files.materialStateRules, materialStateRules);
  return materialStateRules;
}

export function exportPath(requirementId: string, version: string): string {
  return path.join(rootDir, 'exports', 'requirements', requirementId, `${version}.yaml`);
}

export async function writeExport(requirementId: string, version: string, yaml: string): Promise<string> {
  const file = exportPath(requirementId, version);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, yaml, 'utf-8');
  return file;
}

function safeUploadPath(storageKey: string): string {
  const normalized = path.normalize(storageKey).replace(/^(\.\.(\/|\\|$))+/, '');
  return path.join(uploadsDir, normalized);
}

function uploadPartPath(storageKey: string, uploadId: string, partNumber: number): string {
  return path.join(uploadsDir, '.parts', uploadId, `${partNumber}-${path.basename(storageKey)}.part`);
}

export function localAttachmentPath(storageKey: string): string {
  return safeUploadPath(storageKey);
}

export const fileStore: AppStore = {
  readData,
  writeCustomers,
  writeMaterials,
  writeRobotModels,
  writeScenes,
  writeRequirements,
  writeGlobalFields,
  writeMaterialStateRules,
  writeExport,
  async createAttachmentUpload(input) {
    const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(path.dirname(safeUploadPath(input.storageKey)), { recursive: true });
    await mkdir(path.join(uploadsDir, '.parts', uploadId), { recursive: true });
    return { uploadId, storageKey: input.storageKey };
  },
  async uploadAttachmentPart(input) {
    const file = uploadPartPath(input.storageKey, input.uploadId, input.partNumber);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(input.body));
    return { etag: `${input.partNumber}-${input.body.byteLength}` };
  },
  async completeAttachmentUpload(input) {
    const target = safeUploadPath(input.storageKey);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.alloc(0));
    for (const part of input.parts.slice().sort((a, b) => a.partNumber - b.partNumber)) {
      await appendFile(target, await readFile(uploadPartPath(input.storageKey, input.uploadId, part.partNumber)));
    }
    await rm(path.join(uploadsDir, '.parts', input.uploadId), { recursive: true, force: true });
  },
  async abortAttachmentUpload(input) {
    await rm(path.join(uploadsDir, '.parts', input.uploadId), { recursive: true, force: true });
  },
  async deleteAttachment(storageKey) {
    await rm(safeUploadPath(storageKey), { force: true });
  },
};
