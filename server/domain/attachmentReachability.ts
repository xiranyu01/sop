import type { Attachment } from '../../gen/coscene/sop/v1alpha1/catalog_pb';
import type { CanonicalSnapshot } from './appStore';

export type AttachmentOwnership =
  | { kind: 'managed'; storageKey: string; publicUri?: string }
  | { kind: 'external'; publicUri: string };

function httpsUri(value: string): string {
  const preserved = value.trim();
  let url: URL;
  try { url = new URL(preserved); } catch { throw new Error('附件 public URI 必须是有效的 HTTPS URL'); }
  if (url.protocol !== 'https:') throw new Error('附件 public URI 必须使用 HTTPS');
  return preserved;
}

export function attachmentOwnership(attachment: Pick<Attachment, 'storageKey' | 'uri'>): AttachmentOwnership {
  if (attachment.storageKey) {
    return { kind: 'managed', storageKey: attachment.storageKey, publicUri: attachment.uri ? httpsUri(attachment.uri) : undefined };
  }
  if (attachment.uri) return { kind: 'external', publicUri: httpsUri(attachment.uri) };
  throw new Error('附件必须包含 managed storage_key 或 external public_uri');
}

export function publicAttachmentUri(
  attachment: Pick<Attachment, 'storageKey' | 'uri'>,
  publicBaseUrl?: string,
): string {
  const ownership = attachmentOwnership(attachment);
  if (ownership.kind === 'external') return ownership.publicUri;
  if (ownership.publicUri) return ownership.publicUri;
  if (!publicBaseUrl) throw new Error('managed 附件缺少公开 HTTPS base URL');
  const publicBase = publicBaseUrl.trim();
  const base = httpsUri(publicBase.endsWith('/') ? publicBase : `${publicBase}/`);
  return new URL(ownership.storageKey.split('/').map(encodeURIComponent).join('/'), base).toString();
}

function collectAttachmentMetadata(value: unknown, result: Map<string, string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectAttachmentMetadata(item, result);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name === 'string' && record.name.startsWith('attachments/') && typeof record.storageKey === 'string' && record.storageKey) {
    result.set(record.name, record.storageKey);
  }
  for (const item of Object.values(record)) collectAttachmentMetadata(item, result);
}

function collectAttachments(value: unknown, result: Attachment[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectAttachments(item, result);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name === 'string' && record.name.startsWith('attachments/') &&
    typeof record.filename === 'string' && typeof record.mediaType === 'string') result.push(record as unknown as Attachment);
  for (const item of Object.values(record)) collectAttachments(item, result);
}

function collectAttachmentNames(value: unknown, result: Set<string>): void {
  if (typeof value === 'string') {
    if (value.startsWith('attachments/')) result.add(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectAttachmentNames(item, result);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) collectAttachmentNames(item, result);
}

export function referencedManagedStorageKeys(snapshot: CanonicalSnapshot): Set<string> {
  const metadata = new Map<string, string>();
  collectAttachmentMetadata(snapshot, metadata);
  const names = new Set<string>();
  const { attachments: _metadata, operational: _operational, ...references } = snapshot;
  collectAttachmentNames(references, names);
  return new Set([...names].flatMap((name) => metadata.get(name) ?? []));
}

export function activeManagedStorageKeys(snapshot: CanonicalSnapshot): Set<string> {
  const metadata = new Map(snapshot.attachments.flatMap((item) => item.storageKey ? [[item.name, item.storageKey] as const] : []));
  const names = new Set<string>();
  collectAttachmentNames({ materials: snapshot.materials, taskSops: snapshot.taskSops, requirements: snapshot.requirements }, names);
  return new Set([...names].flatMap((name) => metadata.get(name) ?? []));
}

export function hasActiveLease(snapshot: CanonicalSnapshot, storageKey: string, now: Date): boolean {
  return snapshot.operational.leases.some((lease) => lease.storageKey === storageKey &&
    (!lease.expiresAt || new Date(lease.expiresAt).getTime() > now.getTime()));
}

export function findReachableManagedAttachment(snapshot: CanonicalSnapshot, storageKey: string): Attachment | undefined {
  const attachments: Attachment[] = [];
  collectAttachments(snapshot, attachments);
  const referenced = referencedManagedStorageKeys(snapshot);
  return referenced.has(storageKey) ? attachments.find((attachment) => attachment.storageKey === storageKey) : undefined;
}
