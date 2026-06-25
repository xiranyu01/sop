import customersSeed from '../data/customers.json';
import globalFieldsSeed from '../data/global-fields.json';
import materialStateRulesSeed from '../data/material-state-rules.json';
import materialsSeed from '../data/materials.json';
import requirementsSeed from '../data/requirements.json';
import robotModelsSeed from '../data/robot-models.json';
import scenesSeed from '../data/scenes.json';
import type { AppData, Customer, GlobalField, Material, MaterialStateRule, Requirement, RobotModel, Scene } from '../src/types';
import type { AppStore } from './api';

export type D1DatabaseLike = {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
    run(): Promise<unknown>;
  };
};

const seedData: AppData = {
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

export function createD1Store(db: D1DatabaseLike): AppStore {
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
  };
}
