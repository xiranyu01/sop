import type { EntityStatus } from '../src/types';

export function nextPatchVersion(version: string): string {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  const [major = 0, minor = 0, patch = 0] = parts.map((part) => (Number.isNaN(part) ? 0 : part));
  return `${major}.${minor}.${patch + 1}`;
}

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function canEditStatus(status: EntityStatus): boolean {
  return status === 'draft';
}
