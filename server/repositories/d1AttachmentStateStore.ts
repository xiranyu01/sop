import { create } from '@bufbuild/protobuf';
import { AttachmentSchema } from '../../gen/coscene/sop/v1alpha1/catalog_pb';
import { toDomainJson } from '../../shared/domain/codec';
import { assertValidDomainMessage } from '../../shared/domain/validation';
import type {
  AttachmentMetadata,
  AttachmentPartReceipt,
  AttachmentStateStore,
  AttachmentUploadSession,
} from '../domain/services/attachment';
import { attachmentObjectKey, attachmentResourceName } from '../domain/services/attachment';
import { guardProspectiveRow, type RowSizeWarning } from '../domain/rowSize';
import type { D1DatabaseLike, D1RunResultLike } from './d1ResourceRepository';
import { projectResource, withResourceEtag } from './protoProjector';

type UploadRow = {
  uid: string;
  owner_scope: AttachmentUploadSession['owner']['scope'];
  owner_uid: string;
  object_key: string;
  upload_id: string;
  filename: string;
  media_type: string;
  size_bytes: number;
  public_url: string | null;
  metadata_json: string;
  parts_json: string;
};

type MetadataRow = Omit<UploadRow, 'upload_id' | 'parts_json'> & {
  completed_at?: string;
};

export type D1AttachmentStateStoreOptions = {
  clock?: () => string;
  createEtag?: () => string;
  onRowSizeWarning?: (warning: RowSizeWarning) => void;
};

function changeCount(result: D1RunResultLike | undefined): number {
  return result?.meta?.changes ?? result?.changes ?? 0;
}

function jsonObject(value: string, field: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`Stored attachment ${field} is invalid`);
  }
  return parsed as Record<string, unknown>;
}

function partReceipts(value: string): AttachmentPartReceipt[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length > 10) throw new TypeError('Stored attachment parts are invalid');
  const seen = new Set<number>();
  return parsed.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Stored attachment part is invalid');
    const part = item as Record<string, unknown>;
    if (!Number.isInteger(part.partNumber) || (part.partNumber as number) < 1 ||
      (part.partNumber as number) > 10 || typeof part.etag !== 'string' || !part.etag ||
      !Number.isSafeInteger(part.sizeBytes) || (part.sizeBytes as number) < 1) {
      throw new TypeError('Stored attachment part is invalid');
    }
    const partNumber = part.partNumber as number;
    if (seen.has(partNumber)) throw new TypeError('Stored attachment parts contain a duplicate');
    seen.add(partNumber);
    return { partNumber, etag: part.etag, sizeBytes: part.sizeBytes as number };
  }).sort((left, right) => left.partNumber - right.partNumber);
}

function baseMetadata(row: MetadataRow): AttachmentMetadata {
  const owner = { scope: row.owner_scope, uid: row.owner_uid };
  if (row.object_key !== attachmentObjectKey(owner, row.uid)) {
    throw new TypeError('Stored attachment object key does not match its owner');
  }
  return {
    owner,
    uid: row.uid,
    objectKey: row.object_key,
    filename: row.filename,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    ...(row.public_url === null ? {} : { publicUrl: row.public_url }),
    metadata: jsonObject(row.metadata_json, 'metadata'),
    ...(row.completed_at ? { uploadedAt: row.completed_at } : {}),
  };
}

function uploadSession(row: UploadRow): AttachmentUploadSession {
  return {
    ...baseMetadata(row),
    uploadId: row.upload_id,
    parts: partReceipts(row.parts_json),
  };
}

function assertPersistable(value: AttachmentMetadata): void {
  if (value.objectKey !== attachmentObjectKey(value.owner, value.uid)) {
    throw new TypeError('Attachment object key does not match its owner');
  }
  JSON.stringify(value.metadata);
}

function assertUploadPersistable(value: AttachmentUploadSession): void {
  assertPersistable(value);
  partReceipts(JSON.stringify(value.parts));
}

function immutableUploadMatches(row: UploadRow, value: AttachmentUploadSession): boolean {
  return row.upload_id === value.uploadId && row.owner_scope === value.owner.scope &&
    row.owner_uid === value.owner.uid && row.object_key === value.objectKey &&
    row.filename === value.filename && row.media_type === value.mediaType &&
    row.size_bytes === value.sizeBytes && row.public_url === (value.publicUrl ?? null) &&
    row.metadata_json === JSON.stringify(value.metadata);
}

function metadataMatches(actual: AttachmentMetadata, expected: AttachmentMetadata): boolean {
  return actual.uid === expected.uid && actual.owner.scope === expected.owner.scope &&
    actual.owner.uid === expected.owner.uid && actual.objectKey === expected.objectKey &&
    actual.filename === expected.filename && actual.mediaType === expected.mediaType &&
    actual.sizeBytes === expected.sizeBytes && actual.publicUrl === expected.publicUrl &&
    JSON.stringify(actual.metadata) === JSON.stringify(expected.metadata);
}

export function createD1AttachmentStateStore(
  database: D1DatabaseLike,
  options: D1AttachmentStateStoreOptions = {},
): AttachmentStateStore {
  const now = options.clock ?? (() => new Date().toISOString());
  const createEtag = options.createEtag ?? (() => crypto.randomUUID());

  function attachmentCatalog(value: AttachmentMetadata, timestamp: string) {
    const message = create(AttachmentSchema, {
      name: attachmentResourceName(value.uid),
      uid: value.uid,
      filename: value.filename,
      mediaType: value.mediaType,
      sizeBytes: BigInt(value.sizeBytes),
      uri: value.publicUrl,
      storageKey: value.objectKey,
      etag: '',
    });
    assertValidDomainMessage(AttachmentSchema, message);
    const protoJson = withResourceEtag(
      JSON.stringify(toDomainJson(AttachmentSchema, message)),
      createEtag(),
    );
    const projected = projectResource(AttachmentSchema.typeName, protoJson);
    guardProspectiveRow('ATTACHMENT', projected.name, {
      name: projected.name,
      uid: projected.uid,
      kind: projected.kind,
      sourceId: projected.sourceId,
      displayName: projected.displayName,
      sku: projected.sku,
      fieldGroup: projected.fieldGroup,
      fieldStatus: projected.fieldStatus,
      etag: projected.etag,
      protoSchema: AttachmentSchema.typeName,
      protoJson,
      archivedAt: undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    }, options.onRowSizeWarning);
    return { ...projected, protoJson, timestamp };
  }

  async function uploadRow(uid: string): Promise<UploadRow | undefined> {
    return (await database.prepare(`SELECT uid, owner_scope, owner_uid, object_key, upload_id,
      filename, media_type, size_bytes, public_url, metadata_json, parts_json
      FROM SOP_ATTACHMENT_UPLOADS WHERE uid = ?`).bind(uid).first<UploadRow>()) ?? undefined;
  }

  async function completedMetadata(uid: string): Promise<AttachmentMetadata | undefined> {
    const row = await database.prepare(`SELECT uid, owner_scope, owner_uid, object_key,
      filename, media_type, size_bytes, public_url, metadata_json, completed_at
      FROM SOP_ATTACHMENT_METADATA WHERE uid = ?`).bind(uid).first<MetadataRow>();
    return row ? baseMetadata(row) : undefined;
  }

  return {
    async getUpload(uid) {
      const row = await uploadRow(uid);
      return row && uploadSession(row);
    },

    async createUpload(value) {
      assertUploadPersistable(value);
      if (value.parts.length !== 0) throw new TypeError('A new attachment upload cannot contain part receipts');
      const timestamp = now();
      const result = await database.prepare(`INSERT INTO SOP_ATTACHMENT_UPLOADS (
        uid, owner_scope, owner_uid, object_key, upload_id, filename, media_type,
        size_bytes, public_url, metadata_json, parts_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        value.uid,
        value.owner.scope,
        value.owner.uid,
        value.objectKey,
        value.uploadId,
        value.filename,
        value.mediaType,
        value.sizeBytes,
        value.publicUrl ?? null,
        JSON.stringify(value.metadata),
        JSON.stringify(value.parts),
        timestamp,
        timestamp,
      ).run();
      if (changeCount(result) !== 1) throw new Error('Attachment upload was not created');
    },

    async reservePart(uid, uploadId, partNumber, reservationToken) {
      const result = await database.prepare(`INSERT OR IGNORE INTO SOP_ATTACHMENT_PART_RESERVATIONS (
        uid, upload_id, part_number, reservation_token, created_at
      ) SELECT uid, upload_id, ?, ?, ?
        FROM SOP_ATTACHMENT_UPLOADS
        WHERE uid = ? AND upload_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM json_each(parts_json)
            WHERE json_extract(value, '$.partNumber') = ?
          )`).bind(
        partNumber,
        reservationToken,
        now(),
        uid,
        uploadId,
        partNumber,
      ).run();
      return changeCount(result) === 1;
    },

    async recordPart(uid, uploadId, reservationToken, receipt) {
      const receiptJson = JSON.stringify(receipt);
      const results = await database.batch([
        database.prepare(`UPDATE SOP_ATTACHMENT_UPLOADS
          SET parts_json = json_insert(parts_json, '$[#]', json(?)), updated_at = ?
          WHERE uid = ? AND upload_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM json_each(parts_json)
              WHERE json_extract(value, '$.partNumber') = ?
            )
            AND EXISTS (
              SELECT 1 FROM SOP_ATTACHMENT_PART_RESERVATIONS
              WHERE uid = ? AND upload_id = ? AND part_number = ? AND reservation_token = ?
            )`).bind(
          receiptJson,
          now(),
          uid,
          uploadId,
          receipt.partNumber,
          uid,
          uploadId,
          receipt.partNumber,
          reservationToken,
        ),
        database.prepare(`DELETE FROM SOP_ATTACHMENT_PART_RESERVATIONS
          WHERE uid = ? AND upload_id = ? AND part_number = ? AND reservation_token = ?
            AND EXISTS (
              SELECT 1 FROM SOP_ATTACHMENT_UPLOADS, json_each(SOP_ATTACHMENT_UPLOADS.parts_json)
              WHERE SOP_ATTACHMENT_UPLOADS.uid = ? AND SOP_ATTACHMENT_UPLOADS.upload_id = ?
                AND json_extract(value, '$.partNumber') = ?
                AND json_extract(value, '$.etag') = ?
                AND json_extract(value, '$.sizeBytes') = ?
            )`).bind(
          uid,
          uploadId,
          receipt.partNumber,
          reservationToken,
          uid,
          uploadId,
          receipt.partNumber,
          receipt.etag,
          receipt.sizeBytes,
        ),
      ]);
      if (changeCount(results[0]) !== 1 || changeCount(results[1]) !== 1) {
        throw new Error('Attachment upload part reservation changed');
      }
    },

    async releasePart(uid, uploadId, partNumber, reservationToken) {
      await database.prepare(`DELETE FROM SOP_ATTACHMENT_PART_RESERVATIONS
        WHERE uid = ? AND upload_id = ? AND part_number = ? AND reservation_token = ?`).bind(
        uid,
        uploadId,
        partNumber,
        reservationToken,
      ).run();
    },

    async completeUpload(uid, uploadId, value) {
      assertPersistable(value);
      if (value.uid !== uid) throw new Error('Attachment upload changed');
      const completed = await completedMetadata(uid);
      if (completed) {
        if (!metadataMatches(completed, value)) throw new Error('Attachment upload changed');
        return;
      }
      const current = await uploadRow(uid);
      if (!current || !immutableUploadMatches(current, { ...value, uploadId, parts: [] })) {
        throw new Error('Attachment upload changed');
      }
      const completedAt = now();
      const catalog = attachmentCatalog(value, completedAt);
      let results;
      try {
        results = await database.batch([
          database.prepare(`INSERT INTO SOP_ATTACHMENT_METADATA (
            uid, owner_scope, owner_uid, object_key, filename, media_type,
            size_bytes, public_url, metadata_json, created_at, completed_at
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, created_at, ?
            FROM SOP_ATTACHMENT_UPLOADS
            WHERE uid = ? AND upload_id = ?`).bind(
            value.uid,
            value.owner.scope,
            value.owner.uid,
            value.objectKey,
            value.filename,
            value.mediaType,
            value.sizeBytes,
            value.publicUrl ?? null,
            JSON.stringify(value.metadata),
            completedAt,
            uid,
            uploadId,
          ),
          database.prepare(`INSERT INTO SOP_CATALOG_RESOURCES (
            name, uid, kind, source_id, display_name, sku, field_group, field_status,
            etag, proto_schema, proto_json, archived_at, created_at, updated_at
          ) SELECT ?, ?, 'ATTACHMENT', NULL, ?, NULL, NULL, NULL, ?, ?, ?, NULL, ?, ?
            FROM SOP_ATTACHMENT_UPLOADS
            WHERE uid = ? AND upload_id = ?`).bind(
            catalog.name,
            catalog.uid,
            catalog.displayName,
            catalog.etag,
            AttachmentSchema.typeName,
            catalog.protoJson,
            catalog.timestamp,
            catalog.timestamp,
            uid,
            uploadId,
          ),
          database.prepare('DELETE FROM SOP_ATTACHMENT_UPLOADS WHERE uid = ? AND upload_id = ?').bind(uid, uploadId),
        ]);
      } catch (error) {
        const raced = await completedMetadata(uid);
        if (raced && metadataMatches(raced, value)) return;
        throw error;
      }
      if (changeCount(results[0]) !== 1 || changeCount(results[1]) !== 1 || changeCount(results[2]) !== 1) {
        const raced = await completedMetadata(uid);
        if (raced && metadataMatches(raced, value)) return;
        throw new Error('Attachment upload changed');
      }
    },

    async removeUpload(uid, uploadId) {
      const result = await database.prepare(
        'DELETE FROM SOP_ATTACHMENT_UPLOADS WHERE uid = ? AND upload_id = ?',
      ).bind(uid, uploadId).run();
      if (changeCount(result) !== 1) throw new Error('Attachment upload changed');
    },

    async getAttachment(uid) {
      return completedMetadata(uid);
    },

    async removeAttachment(uid) {
      const result = await database.prepare('DELETE FROM SOP_ATTACHMENT_METADATA WHERE uid = ?').bind(uid).run();
      return changeCount(result) === 1;
    },
  };
}
