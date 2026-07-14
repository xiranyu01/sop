import type { CanonicalSnapshot } from '../domain/appStore';
import { stableHash, stableJson } from './identity';

export function fingerprintSource(value: unknown): string {
  return stableHash(stableJson(value));
}

export function fingerprintRecord(source: unknown, canonical: unknown): string {
  return stableHash(stableJson({ source, canonical }));
}

export function canonicalSemanticDigest(snapshot: CanonicalSnapshot): string {
  const { operational: _operational, ...domain } = snapshot;
  return stableHash(stableJson(domain));
}

export function canonicalCardinalities(snapshot: CanonicalSnapshot): Record<string, number> {
  return Object.fromEntries(Object.entries(snapshot)
    .filter(([, value]) => Array.isArray(value))
    .map(([key, value]) => [key, (value as unknown[]).length]));
}

export function canonicalIdentities(snapshot: CanonicalSnapshot): Record<string, string[]> {
  return Object.fromEntries(Object.entries(snapshot)
    .filter(([, value]) => Array.isArray(value))
    .map(([key, value]) => [key, (value as Array<{ name?: string }>).map((item) => item.name ?? '').filter(Boolean).sort()]));
}
