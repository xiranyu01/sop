import customersSeed from '../data/customers.json';
import globalFieldsSeed from '../data/global-fields.json';
import materialStateRulesSeed from '../data/material-state-rules.json';
import materialsSeed from '../data/materials.json';
import metadataSeed from '../data/metadata.json';
import requirementsSeed from '../data/requirements.json';
import robotModelsSeed from '../data/robot-models.json';
import scenesSeed from '../data/scenes.json';
import { defaultAppMetadata } from '../src/schemaVersions';
import type { AppData, AppMetadata, Customer, GlobalField, Material, MaterialStateRule, Requirement, RobotModel, Scene } from '../shared/transport/restDto';
import type { LegacyApiStore } from '../shared/transport/restDto';
import type { AttachmentStore } from './r2AttachmentStore';
import {
  decodeCanonicalSnapshot,
  emptyCanonicalSnapshot,
  encodeCanonicalSnapshot,
  type AppStore,
  type CanonicalSnapshot,
  type StorePin,
} from './domain/appStore';
import { AtomicCommitError, NamespaceNotFoundError, StaleStoreEpochError, WriteFrozenError } from './domain/errors';

export type D1RunResult = { success?: boolean; changes?: number; meta?: { changes?: number } };

export type D1PreparedStatementLike = {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<D1RunResult>;
};

export type D1DatabaseLike = {
  prepare(query: string): D1PreparedStatementLike;
};

type CanonicalD1Row = {
  namespace: string;
  epoch: number;
  writable: number;
  generation: number;
  snapshot_json: string;
};

export type CanonicalD1StoreOptions = {
  defaultNamespace?: string;
  bootstrap?: { namespace: string; snapshot: CanonicalSnapshot; writable?: boolean };
  assumeInitialized?: boolean;
  faultInjection?: (point: 'before-atomic-update') => void | Promise<void>;
};

async function ensureCanonicalTables(db: D1DatabaseLike, defaultNamespace: string): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS canonical_namespaces (
    namespace TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL,
    writable INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS canonical_store_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`).run();
  await db.prepare(`INSERT OR IGNORE INTO canonical_namespaces
    (namespace, epoch, writable, generation, snapshot_json, updated_at)
    VALUES (?, 1, 1, 0, ?, ?)`)
    .bind(defaultNamespace, encodeCanonicalSnapshot(emptyCanonicalSnapshot()), new Date().toISOString()).run();
  await db.prepare(`INSERT OR IGNORE INTO canonical_store_meta (key, value) VALUES ('active_namespace', ?)`)
    .bind(defaultNamespace).run();
}

function rowPin(row: CanonicalD1Row): StorePin {
  return { namespace: row.namespace, epoch: Number(row.epoch), generation: Number(row.generation), writable: Boolean(row.writable) };
}

async function canonicalRow(db: D1DatabaseLike, namespace: string): Promise<CanonicalD1Row> {
  const row = await db.prepare('SELECT namespace, epoch, writable, generation, snapshot_json FROM canonical_namespaces WHERE namespace = ?')
    .bind(namespace).first<CanonicalD1Row>();
  if (!row) throw new NamespaceNotFoundError(namespace);
  return row;
}

function changed(result: D1RunResult): boolean | undefined {
  const count = result.meta?.changes ?? result.changes;
  return count === undefined ? undefined : count > 0;
}

export function createCanonicalD1AppStore(db: D1DatabaseLike, options: CanonicalD1StoreOptions = {}): AppStore {
  const defaultNamespace = options.defaultNamespace ?? 'v1alpha1-default';
  let initialization: Promise<void> | undefined = options.assumeInitialized ? Promise.resolve() : undefined;

  async function initializeStore(): Promise<void> {
    await ensureCanonicalTables(db, defaultNamespace);
    if (options.bootstrap && options.bootstrap.namespace !== defaultNamespace) {
      await db.prepare(`INSERT OR IGNORE INTO canonical_namespaces
        (namespace, epoch, writable, generation, snapshot_json, updated_at)
        VALUES (?, 1, ?, 0, ?, ?)`)
        .bind(
          options.bootstrap.namespace,
          options.bootstrap.writable === false ? 0 : 1,
          encodeCanonicalSnapshot(options.bootstrap.snapshot),
          new Date().toISOString(),
        ).run();
    }
  }

  function initialize(): Promise<void> {
    if (!initialization) {
      const pending = initializeStore();
      initialization = pending;
      void pending.catch(() => {
        if (initialization === pending) initialization = undefined;
      });
    }
    return initialization;
  }

  async function diagnoseRejectedMutation(pin: StorePin): Promise<never> {
    const row = await canonicalRow(db, pin.namespace);
    if (Number(row.epoch) !== pin.epoch) throw new StaleStoreEpochError(pin.namespace, pin.epoch, Number(row.epoch));
    if (!row.writable) throw new WriteFrozenError(pin.namespace);
    throw new AtomicCommitError(`Canonical D1 generation changed for ${pin.namespace}`);
  }

  return {
    async pin(namespace) {
      await initialize();
      let selected = namespace;
      if (!selected) {
        const active = await db.prepare("SELECT value FROM canonical_store_meta WHERE key = 'active_namespace'").first<{ value: string }>();
        selected = active?.value ?? defaultNamespace;
      }
      return rowPin(await canonicalRow(db, selected));
    },
    async readSnapshot(pin) {
      await initialize();
      const row = await canonicalRow(db, pin.namespace);
      if (Number(row.epoch) !== pin.epoch) throw new StaleStoreEpochError(pin.namespace, pin.epoch, Number(row.epoch));
      if (Number(row.generation) !== pin.generation) throw new AtomicCommitError(`Canonical D1 generation changed for ${pin.namespace}`);
      return decodeCanonicalSnapshot(row.snapshot_json);
    },
    async commit(pin, mutation) {
      await initialize();
      const before = await canonicalRow(db, pin.namespace);
      if (Number(before.epoch) !== pin.epoch) throw new StaleStoreEpochError(pin.namespace, pin.epoch, Number(before.epoch));
      if (!before.writable) throw new WriteFrozenError(pin.namespace);
      if (Number(before.generation) !== pin.generation) throw new AtomicCommitError(`Canonical D1 generation changed for ${pin.namespace}`);
      const snapshot = await mutation(decodeCanonicalSnapshot(before.snapshot_json));
      const encoded = encodeCanonicalSnapshot(snapshot);
      if (encoded === before.snapshot_json) {
        return { pin: rowPin(before), snapshot: decodeCanonicalSnapshot(encoded) };
      }
      await options.faultInjection?.('before-atomic-update');
      const result = await db.prepare(`UPDATE canonical_namespaces
        SET snapshot_json = ?, generation = generation + 1, updated_at = ?
        WHERE namespace = ? AND epoch = ? AND generation = ? AND writable = 1`)
        .bind(encoded, new Date().toISOString(), pin.namespace, pin.epoch, pin.generation).run();
      const didChange = changed(result);
      if (didChange === false) return diagnoseRejectedMutation(pin);
      if (didChange === true) {
        return {
          pin: { ...pin, generation: pin.generation + 1 },
          snapshot: decodeCanonicalSnapshot(encoded),
        };
      }
      const after = await canonicalRow(db, pin.namespace);
      if (after.snapshot_json !== encoded || Number(after.generation) !== pin.generation + 1) return diagnoseRejectedMutation(pin);
      return { pin: rowPin(after), snapshot: decodeCanonicalSnapshot(encoded) };
    },
    async setWriteState(pin, writable) {
      await initialize();
      const result = await db.prepare(`UPDATE canonical_namespaces
        SET epoch = epoch + 1, writable = ?, updated_at = ?
        WHERE namespace = ? AND epoch = ?`)
        .bind(writable ? 1 : 0, new Date().toISOString(), pin.namespace, pin.epoch).run();
      const didChange = changed(result);
      if (didChange === false) return diagnoseRejectedMutation(pin);
      if (didChange === true) return { ...pin, epoch: pin.epoch + 1, writable };
      const after = await canonicalRow(db, pin.namespace);
      if (Number(after.epoch) !== pin.epoch + 1 || Boolean(after.writable) !== writable) return diagnoseRejectedMutation(pin);
      return rowPin(after);
    },
  };
}

const seedData: AppData = {
  metadata: { ...defaultAppMetadata, ...(metadataSeed as Partial<AppMetadata>) },
  customers: customersSeed as Customer[],
  materials: materialsSeed as Material[],
  robotModels: robotModelsSeed as RobotModel[],
  scenes: scenesSeed as Scene[],
  requirements: requirementsSeed as Requirement[],
  globalFields: globalFieldsSeed as GlobalField[],
  materialStateRules: materialStateRulesSeed as MaterialStateRule[],
};

type DataKey = keyof AppData;

const dataKeys: DataKey[] = [
  'metadata',
  'customers',
  'materials',
  'robotModels',
  'scenes',
  'requirements',
  'globalFields',
  'materialStateRules',
];

async function ensureTable(db: D1DatabaseLike) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS app_data (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    )
    .run();
}

async function readKey<T>(db: D1DatabaseLike, key: DataKey): Promise<T> {
  await ensureTable(db);
  const row = await db.prepare('SELECT value FROM app_data WHERE key = ?').bind(key).first<{ value: string }>();
  if (row) {
    return JSON.parse(row.value) as T;
  }
  const seedValue = seedData[key] as T;
  await writeKey(db, key, seedValue);
  return seedValue;
}

async function writeKey<T>(db: D1DatabaseLike, key: DataKey, value: T): Promise<T> {
  await ensureTable(db);
  await db
    .prepare(
      `INSERT INTO app_data (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, JSON.stringify(value), new Date().toISOString())
    .run();
  return value;
}

export function createD1Store(db: D1DatabaseLike, attachmentStore: AttachmentStore = {}): LegacyApiStore {
  return {
    async readData(): Promise<AppData> {
      const values = await Promise.all(dataKeys.map((key) => readKey(db, key)));
      return dataKeys.reduce((data, key, index) => {
        return { ...data, [key]: values[index] };
      }, {} as AppData);
    },
    writeCustomers: (customers) => writeKey(db, 'customers', customers),
    writeMaterials: (materials) => writeKey(db, 'materials', materials),
    writeRobotModels: (robotModels) => writeKey(db, 'robotModels', robotModels),
    writeScenes: (scenes) => writeKey(db, 'scenes', scenes),
    writeRequirements: (requirements) => writeKey(db, 'requirements', requirements),
    writeGlobalFields: (globalFields) => writeKey(db, 'globalFields', globalFields),
    writeMaterialStateRules: (materialStateRules) => writeKey(db, 'materialStateRules', materialStateRules),
    async writeExport(requirementId, version) {
      return `/exports/requirements/${requirementId}/${version}.yaml`;
    },
    ...attachmentStore,
  };
}
