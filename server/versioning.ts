import type { EntityStatus } from '../shared/transport/restDto';

export function nextPatchVersion(version: string): string {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  const [major = 0, minor = 0, patch = 0] = parts.map((part) => (Number.isNaN(part) ? 0 : part));
  return `${major}.${minor}.${patch + 1}`;
}

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createShortId(usedIds: string[] = [], length = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const used = new Set(usedIds.map((id) => id.toUpperCase()));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let value = '';
    for (let index = 0; index < length; index += 1) {
      value += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!used.has(value)) return value;
  }
  return Date.now().toString(36).slice(-length).toUpperCase();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function canEditStatus(status: EntityStatus): boolean {
  return status === 'draft';
}
