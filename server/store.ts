import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { defaultAppMetadata } from '../src/schemaVersions';
import type { AppData, AppMetadata, Customer, GlobalField, Material, MaterialStateRule, Requirement, RobotModel, Scene } from '../src/types';
import type { LegacyApiStore } from '../shared/transport/restDto';
import {
  decodeCanonicalSnapshot,
  emptyCanonicalSnapshot,
  encodeCanonicalSnapshot,
  type AppStore,
  type CanonicalSnapshot,
  type StorePin,
} from './domain/appStore';
import { AtomicCommitError, NamespaceNotFoundError, StaleStoreEpochError, WriteFrozenError } from './domain/errors';

export type FileStoreOptions = {
  dataDir?: string;
  uploadsDir?: string;
  exportsDir?: string;
};

export type CanonicalFileStoreOptions = {
  rootDir: string;
  defaultNamespace?: string;
  faultInjection?: (point: 'before-generation-publish' | 'before-manifest-publish') => void | Promise<void>;
};

export type LocalFileStore = LegacyApiStore & {
  localAttachmentPath(storageKey: string): string;
};

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(file, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson<T>(file: string, data: T): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, 'utf-8');
  await rename(temporary, file);
}

type CanonicalManifest = StorePin & { schemaVersion: string };

export function createCanonicalFileAppStore(options: CanonicalFileStoreOptions): AppStore {
  const root = path.resolve(options.rootDir);
  const defaultNamespace = options.defaultNamespace ?? 'v1alpha1-default';
  const activeFile = path.join(root, 'active-namespace');
  let queue = Promise.resolve();

  function namespaceRoot(namespace: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(namespace)) throw new Error('Invalid canonical namespace');
    return path.join(root, 'namespaces', namespace);
  }

  function manifestFile(namespace: string): string {
    return path.join(namespaceRoot(namespace), 'manifest.json');
  }

  function generationFile(namespace: string, generation: number): string {
    return path.join(namespaceRoot(namespace), 'generations', `${generation}.json`);
  }

  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const current = queue.then(operation, operation);
    queue = current.then(() => undefined, () => undefined);
    return current;
  }

  async function initialize(): Promise<void> {
    try {
      await readFile(activeFile, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const initial = emptyCanonicalSnapshot();
      await atomicWrite(generationFile(defaultNamespace, 0), encodeCanonicalSnapshot(initial));
      const manifest: CanonicalManifest = {
        namespace: defaultNamespace,
        epoch: 1,
        generation: 0,
        writable: true,
        schemaVersion: initial.schemaVersion,
      };
      await atomicWrite(manifestFile(defaultNamespace), JSON.stringify(manifest));
      await atomicWrite(activeFile, defaultNamespace);
    }
  }

  async function readManifest(namespace: string): Promise<CanonicalManifest> {
    try {
      return JSON.parse(await readFile(manifestFile(namespace), 'utf-8')) as CanonicalManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NamespaceNotFoundError(namespace);
      throw error;
    }
  }

  function assertEpoch(manifest: CanonicalManifest, pin: StorePin): void {
    if (manifest.epoch !== pin.epoch) throw new StaleStoreEpochError(pin.namespace, pin.epoch, manifest.epoch);
  }

  return {
    pin(namespace) {
      return exclusive(async () => {
        await initialize();
        const selected = namespace ?? (await readFile(activeFile, 'utf-8')).trim();
        const manifest = await readManifest(selected);
        return { namespace: selected, epoch: manifest.epoch, generation: manifest.generation, writable: manifest.writable };
      });
    },
    async readSnapshot(pin) {
      await initialize();
      return decodeCanonicalSnapshot(await readFile(generationFile(pin.namespace, pin.generation), 'utf-8'));
    },
    commit(pin, mutation) {
      return exclusive(async () => {
        await initialize();
        const manifest = await readManifest(pin.namespace);
        assertEpoch(manifest, pin);
        if (!manifest.writable) throw new WriteFrozenError(pin.namespace);
        if (manifest.generation !== pin.generation) {
          throw new AtomicCommitError(`Canonical file generation changed for ${pin.namespace}`);
        }
        const current = decodeCanonicalSnapshot(await readFile(generationFile(pin.namespace, pin.generation), 'utf-8'));
        const next = await mutation(current);
        const encoded = encodeCanonicalSnapshot(next);
        const generation = manifest.generation + 1;
        try {
          await options.faultInjection?.('before-generation-publish');
          await atomicWrite(generationFile(pin.namespace, generation), encoded);
          await options.faultInjection?.('before-manifest-publish');
          const nextManifest: CanonicalManifest = { ...manifest, generation };
          await atomicWrite(manifestFile(pin.namespace), JSON.stringify(nextManifest));
          return {
            pin: { namespace: pin.namespace, epoch: manifest.epoch, generation, writable: true },
            snapshot: decodeCanonicalSnapshot(encoded),
          };
        } catch (error) {
          throw new AtomicCommitError('Canonical file commit was not published', error);
        }
      });
    },
    setWriteState(pin, writable) {
      return exclusive(async () => {
        await initialize();
        const manifest = await readManifest(pin.namespace);
        assertEpoch(manifest, pin);
        const next: CanonicalManifest = { ...manifest, epoch: manifest.epoch + 1, writable };
        await atomicWrite(manifestFile(pin.namespace), JSON.stringify(next));
        return { namespace: pin.namespace, epoch: next.epoch, generation: next.generation, writable: next.writable };
      });
    },
  };
}

function containedPath(root: string, storageKey: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, storageKey);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('附件路径无效');
  }
  return resolved;
}

export function createFileStore(options: FileStoreOptions = {}): LocalFileStore {
  const rootDir = process.cwd();
  const dataDir = path.resolve(options.dataDir ?? path.join(rootDir, 'data'));
  const uploadsDir = path.resolve(options.uploadsDir ?? path.join(rootDir, 'uploads'));
  const exportsDir = path.resolve(options.exportsDir ?? path.join(rootDir, 'exports'));
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

  function safeUploadPath(storageKey: string): string {
    return containedPath(uploadsDir, storageKey);
  }

  function uploadPartPath(storageKey: string, uploadId: string, partNumber: number): string {
    return containedPath(path.join(uploadsDir, '.parts'), path.join(uploadId, `${partNumber}-${path.basename(storageKey)}.part`));
  }

  const store: LocalFileStore = {
    async readData() {
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
    },
    async writeCustomers(customers) {
      await writeJson(files.customers, customers);
      return customers;
    },
    async writeMaterials(materials) {
      await writeJson(files.materials, materials);
      return materials;
    },
    async writeRobotModels(robotModels) {
      await writeJson(files.robotModels, robotModels);
      return robotModels;
    },
    async writeScenes(scenes) {
      await writeJson(files.scenes, scenes);
      return scenes;
    },
    async writeRequirements(requirements) {
      await writeJson(files.requirements, requirements);
      return requirements;
    },
    async writeGlobalFields(globalFields) {
      await writeJson(files.globalFields, globalFields);
      return globalFields;
    },
    async writeMaterialStateRules(materialStateRules) {
      await writeJson(files.materialStateRules, materialStateRules);
      return materialStateRules;
    },
    async writeExport(requirementId, version, yaml) {
      const file = containedPath(exportsDir, path.join('requirements', requirementId, `${version}.yaml`));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, yaml, 'utf-8');
      return file;
    },
    localAttachmentPath: safeUploadPath,
    async createAttachmentUpload(input) {
      const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await mkdir(path.dirname(safeUploadPath(input.storageKey)), { recursive: true });
      await mkdir(containedPath(path.join(uploadsDir, '.parts'), uploadId), { recursive: true });
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
      await rm(containedPath(path.join(uploadsDir, '.parts'), input.uploadId), { recursive: true, force: true });
    },
    async abortAttachmentUpload(input) {
      await rm(containedPath(path.join(uploadsDir, '.parts'), input.uploadId), { recursive: true, force: true });
    },
    async deleteAttachment(storageKey) {
      await rm(safeUploadPath(storageKey), { force: true });
    },
  };

  return store;
}

export const fileStore = createFileStore();

export function localAttachmentPath(storageKey: string): string {
  return fileStore.localAttachmentPath(storageKey);
}
