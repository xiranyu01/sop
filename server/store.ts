import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { defaultAppMetadata } from '../src/schemaVersions';
import type { AppData, AppMetadata, Customer, GlobalField, Material, MaterialStateRule, Requirement, RobotModel, Scene } from '../src/types';
import type { LegacyApiStore } from '../shared/transport/restDto';
import type { AttachmentObjectStore, AttachmentObjectMetadata } from './domain/attachmentObjectStore';
import {
  assertExpectedObjectSize,
  normalizeAttachmentComplete,
  validateAttachmentPart,
  validateAttachmentUpload,
  validateStorageKey,
  validateUploadSession,
} from './domain/attachmentObjectStore';
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
  bootstrap?: { namespace: string; snapshot: CanonicalSnapshot; writable?: boolean };
  faultInjection?: (point: 'before-generation-publish' | 'before-manifest-publish') => void | Promise<void>;
};

export type LocalFileStore = LegacyApiStore & AttachmentObjectStore & {
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
    if (options.bootstrap && options.bootstrap.namespace !== defaultNamespace) {
      try {
        await readFile(manifestFile(options.bootstrap.namespace), 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await atomicWrite(generationFile(options.bootstrap.namespace, 0), encodeCanonicalSnapshot(options.bootstrap.snapshot));
        const manifest: CanonicalManifest = {
          namespace: options.bootstrap.namespace,
          epoch: 1,
          generation: 0,
          writable: options.bootstrap.writable ?? true,
          schemaVersion: options.bootstrap.snapshot.schemaVersion,
        };
        await atomicWrite(manifestFile(options.bootstrap.namespace), JSON.stringify(manifest));
      }
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
      const manifest = await readManifest(pin.namespace);
      assertEpoch(manifest, pin);
      if (manifest.generation !== pin.generation) {
        throw new AtomicCommitError(`Canonical file generation changed for ${pin.namespace}`);
      }
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

  type LocalUploadSession = { storageKey: string; contentType: string };
  type LocalCompletionReceipt = {
    storageKey: string;
    parts: Array<{ partNumber: number; etag: string }>;
    metadata: AttachmentObjectMetadata;
  };

  function uploadSessionRoot(uploadId: string): string {
    return containedPath(path.join(uploadsDir, '.parts'), uploadId);
  }

  function uploadSessionFile(uploadId: string): string {
    return path.join(uploadSessionRoot(uploadId), 'session.json');
  }

  function completionReceiptFile(uploadId: string): string {
    return containedPath(path.join(uploadsDir, '.completed'), `${uploadId}.json`);
  }

  function objectMetadataFile(storageKey: string): string {
    return `${safeUploadPath(storageKey)}.object-metadata.json`;
  }

  async function optionalJson<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(file, 'utf-8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async function localHeadAttachment(storageKey: string): Promise<AttachmentObjectMetadata | null> {
    validateStorageKey(storageKey);
    const file = safeUploadPath(storageKey);
    try {
      const actual = await stat(file);
      const saved = await optionalJson<AttachmentObjectMetadata>(objectMetadataFile(storageKey));
      if (saved && saved.storageKey !== storageKey) throw new Error('local attachment metadata key mismatch');
      const sha256 = saved?.sha256 ?? createHash('sha256').update(await readFile(file)).digest('hex');
      return {
        storageKey,
        sizeBytes: actual.size,
        contentType: saved?.contentType,
        etag: saved?.etag,
        sha256,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
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
      validateAttachmentUpload(input);
      const uploadId = randomUUID();
      await mkdir(path.dirname(safeUploadPath(input.storageKey)), { recursive: true });
      await mkdir(uploadSessionRoot(uploadId), { recursive: true });
      await atomicWrite(uploadSessionFile(uploadId), JSON.stringify({ storageKey: input.storageKey, contentType: input.contentType } satisfies LocalUploadSession));
      return { uploadId, storageKey: input.storageKey };
    },
    async uploadAttachmentPart(input) {
      validateAttachmentPart(input);
      const session = await optionalJson<LocalUploadSession>(uploadSessionFile(input.uploadId));
      if (!session || session.storageKey !== input.storageKey) throw new Error('multipart upload session does not match storage key');
      const file = uploadPartPath(input.storageKey, input.uploadId, input.partNumber);
      await mkdir(path.dirname(file), { recursive: true });
      const body = Buffer.from(input.body);
      await writeFile(file, body);
      return { etag: `${input.partNumber}-${body.byteLength}-${createHash('sha256').update(body).digest('hex').slice(0, 16)}` };
    },
    async completeAttachmentUpload(input) {
      const parts = normalizeAttachmentComplete(input);
      const receipt = await optionalJson<LocalCompletionReceipt>(completionReceiptFile(input.uploadId));
      if (receipt) {
        if (receipt.storageKey !== input.storageKey || JSON.stringify(receipt.parts) !== JSON.stringify(parts)) {
          throw new Error('completed multipart receipt does not match retry request');
        }
        assertExpectedObjectSize(await localHeadAttachment(input.storageKey), input.expectedSizeBytes);
        return;
      }
      const session = await optionalJson<LocalUploadSession>(uploadSessionFile(input.uploadId));
      if (!session || session.storageKey !== input.storageKey) throw new Error('multipart upload session does not match storage key');
      const target = safeUploadPath(input.storageKey);
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${input.uploadId}.tmp`;
      const hash = createHash('sha256');
      let sizeBytes = 0;
      await writeFile(temporary, Buffer.alloc(0));
      for (const part of parts) {
        const body = await readFile(uploadPartPath(input.storageKey, input.uploadId, part.partNumber));
        const actualEtag = `${part.partNumber}-${body.byteLength}-${createHash('sha256').update(body).digest('hex').slice(0, 16)}`;
        if (part.etag !== actualEtag) {
          await rm(temporary, { force: true });
          throw new Error(`multipart part ${part.partNumber} ETag does not match uploaded bytes`);
        }
        sizeBytes += body.byteLength;
        hash.update(body);
        await appendFile(temporary, body);
      }
      if (input.expectedSizeBytes !== undefined && sizeBytes !== input.expectedSizeBytes) {
        await rm(temporary, { force: true });
        throw new Error(`completed attachment size ${sizeBytes} does not match expected size ${input.expectedSizeBytes}`);
      }
      const sha256 = hash.digest('hex');
      await rename(temporary, target);
      const metadata: AttachmentObjectMetadata = {
        storageKey: input.storageKey,
        sizeBytes,
        contentType: session.contentType,
        etag: sha256,
        sha256,
      };
      await atomicWrite(objectMetadataFile(input.storageKey), JSON.stringify(metadata));
      await atomicWrite(completionReceiptFile(input.uploadId), JSON.stringify({ storageKey: input.storageKey, parts, metadata } satisfies LocalCompletionReceipt));
      await rm(uploadSessionRoot(input.uploadId), { recursive: true, force: true });
    },
    async abortAttachmentUpload(input) {
      validateUploadSession(input);
      const receipt = await optionalJson<LocalCompletionReceipt>(completionReceiptFile(input.uploadId));
      if (receipt) {
        if (receipt.storageKey !== input.storageKey) throw new Error('completed multipart receipt does not match abort request');
        return;
      }
      await rm(uploadSessionRoot(input.uploadId), { recursive: true, force: true });
    },
    async deleteAttachment(storageKey) {
      validateStorageKey(storageKey);
      await rm(safeUploadPath(storageKey), { force: true });
      await rm(objectMetadataFile(storageKey), { force: true });
    },
    async getAttachment(storageKey) {
      const metadata = await localHeadAttachment(storageKey);
      if (!metadata) return null;
      const body = await readFile(safeUploadPath(storageKey));
      return {
        body: new Blob([body]).stream(),
        metadata,
        httpMetadata: { contentType: metadata.contentType },
      };
    },
    headAttachment: localHeadAttachment,
    async attachmentExists(storageKey) {
      return (await localHeadAttachment(storageKey)) !== null;
    },
  };

  return store;
}

export const fileStore = createFileStore();

export function localAttachmentPath(storageKey: string): string {
  return fileStore.localAttachmentPath(storageKey);
}
