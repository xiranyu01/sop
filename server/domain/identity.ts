import { hexBytes, sha1, sha256 } from '../../shared/crypto/hash';

export const identityVersion = 'identity-v1';

const urlNamespace = hexBytes('6ba7b8119dad11d180b400c04fd430c8');
const canonicalIdPattern = /^[a-z][a-z0-9-]{0,62}$/;

export function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function stableHash(value: string): string {
  return sha256(value);
}

export function stableJson(value: unknown): string {
  if (value === undefined) return '{"$undefined":true}';
  if (typeof value === 'bigint') return `{"$bigint":${JSON.stringify(value.toString())}}`;
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareStable(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function deterministicUid(kind: string, legacyIdentity: string): string {
  const name = `https://coscene.io/sop/${identityVersion}/${encodeURIComponent(kind)}/${encodeURIComponent(legacyIdentity)}`;
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(urlNamespace.length + nameBytes.length);
  input.set(urlNamespace);
  input.set(nameBytes, urlNamespace.length);
  const bytes = hexBytes(sha1(input));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function canonicalId(value: string, fallbackSeed: string): string {
  if (canonicalIdPattern.test(value)) return value;
  const normalized = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 54)
    .replace(/-+$/g, '');
  if (normalized) return `${normalized}-${stableHash(fallbackSeed).slice(0, 8)}`;
  return `id-${stableHash(fallbackSeed).slice(0, 16)}`;
}

export function resourceName(collection: string, legacyId: string): string {
  return `${collection}/${canonicalId(legacyId, `${collection}:${legacyId}`)}`;
}

export function revisionId(versionLabel: string, legacyVersionId?: string): string {
  const seed = legacyVersionId || `v-${versionLabel.replace(/\./g, '-')}`;
  return canonicalId(seed, `revision:${versionLabel}:${legacyVersionId ?? ''}`);
}

export function revisionName(resource: string, versionLabel: string, legacyVersionId?: string): string {
  return `${resource}/revisions/${revisionId(versionLabel, legacyVersionId)}`;
}

export class IdentityRegistry {
  readonly aliases = new Map<string, string>();
  readonly owners = new Map<string, string>();
  readonly collisions: Array<{ canonical: string; owner: string; contender: string }> = [];

  register(canonical: string, owner: string, aliases: string[] = []): void {
    const existing = this.owners.get(canonical);
    if (existing && existing !== owner) this.collisions.push({ canonical, owner: existing, contender: owner });
    else this.owners.set(canonical, owner);
    for (const alias of aliases.filter(Boolean)) {
      const mapped = this.aliases.get(alias);
      if (mapped && mapped !== canonical) this.collisions.push({ canonical: alias, owner: mapped, contender: canonical });
      else this.aliases.set(alias, canonical);
    }
  }
}
