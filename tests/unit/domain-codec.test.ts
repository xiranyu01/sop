import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { MaterialSchema } from '../../gen/coscene/sop/v1alpha1/catalog_pb';
import { OperationStepSchema, Priority } from '../../gen/coscene/sop/v1alpha1/common_pb';
import { RequirementSpecSchema, WorkloadTargetSchema } from '../../gen/coscene/sop/v1alpha1/requirement_pb';
import { fromDomainJson, fromDomainJsonString, ProtoJsonDecodeError, toDomainJson } from '../../shared/domain/codec';
import { DomainValidationError, assertValidDomainMessage, validateDomainMessage } from '../../shared/domain/validation';
import { decodeCanonicalSnapshot, emptyCanonicalSnapshot, encodeCanonicalSnapshot } from '../../server/domain/appStore';
import { CanonicalDataError } from '../../server/domain/errors';

describe('canonical domain codec', () => {
  it('round-trips ProtoJSON enums, date, duration, int64 and optional presence', () => {
    const spec = fromDomainJson(RequirementSpecSchema, {
      deadline: { year: 2026, month: 7, day: 14 },
      priority: 'PRIORITY_P1',
      aggregateTarget: { duration: '3600s', collectionCount: '12' },
    });
    const json = toDomainJson(RequirementSpecSchema, spec) as Record<string, unknown>;
    expect(spec.priority).toBe(Priority.P1);
    expect(spec.deadline).toMatchObject({ year: 2026, month: 7, day: 14 });
    expect(spec.aggregateTarget?.duration).toMatchObject({ seconds: 3600n });
    expect(json).toMatchObject({ deadline: { year: 2026, month: 7, day: 14 }, priority: 'PRIORITY_P1' });

    const absent = fromDomainJson(MaterialSchema, { displayName: 'Cup' });
    const present = fromDomainJson(MaterialSchema, { displayName: 'Cup', size: '' });
    expect(absent.size).toBeUndefined();
    expect(present.size).toBe('');
  });

  it('rejects unknown fields, malformed values, duplicate keys and non-objects', () => {
    expect(() => fromDomainJson(MaterialSchema, { displayName: 'Cup', mystery: true })).toThrow(ProtoJsonDecodeError);
    expect(() => fromDomainJson(MaterialSchema, { displayName: 'Cup', createTime: 'not-a-time' })).toThrow(ProtoJsonDecodeError);
    expect(() => fromDomainJson(MaterialSchema, null)).toThrow('expected a JSON object');
    expect(() => fromDomainJsonString(MaterialSchema, '{"displayName":"A","displayName":"B"}')).toThrow(ProtoJsonDecodeError);
  });

  it('aggregates validation violations and distinguishes user errors from validator failures', () => {
    const invalid = create(OperationStepSchema, { id: 'INVALID ID', order: 0, description: '' });
    const result = validateDomainMessage(OperationStepSchema, invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.length).toBeGreaterThanOrEqual(3);
      expect(result.violations.map((item) => item.fieldPath)).toEqual(expect.arrayContaining(['id', 'description', 'order']));
    }
    expect(() => assertValidDomainMessage(OperationStepSchema, invalid)).toThrow(DomainValidationError);
    expect(() => assertValidDomainMessage(WorkloadTargetSchema, create(WorkloadTargetSchema))).toThrow('at least one positive');
  });

  it('fails closed on malformed or unknown persisted snapshot data', () => {
    const encoded = encodeCanonicalSnapshot(emptyCanonicalSnapshot());
    expect(decodeCanonicalSnapshot(encoded)).toEqual(emptyCanonicalSnapshot());
    const malformed = JSON.parse(encoded) as { resources: Record<string, unknown[]> };
    malformed.resources.materials.push({ displayName: 'Cup', unknownField: true });
    expect(() => decodeCanonicalSnapshot(JSON.stringify(malformed))).toThrow(CanonicalDataError);
  });

  it('keeps pre-operational empty snapshots byte-stable and round-trips versioned attachment operations', () => {
    const oldEnvelope = encodeCanonicalSnapshot(emptyCanonicalSnapshot());
    expect(oldEnvelope).not.toContain('operational');
    expect(encodeCanonicalSnapshot(decodeCanonicalSnapshot(oldEnvelope))).toBe(oldEnvelope);

    const withOperations = emptyCanonicalSnapshot();
    withOperations.operational.leases.push({
      storageKey: 'managed/held.bin', generationId: 'rollback-generation', expiresAt: '2026-07-21T00:00:00.000Z',
    });
    expect(decodeCanonicalSnapshot(encodeCanonicalSnapshot(withOperations)).operational).toEqual(withOperations.operational);
    const malformedLease = JSON.parse(encodeCanonicalSnapshot(withOperations)) as {
      operational: { leases: Array<{ expiresAt?: string }> };
    };
    malformedLease.operational.leases[0].expiresAt = 'not-an-iso-time';
    expect(() => decodeCanonicalSnapshot(JSON.stringify(malformedLease))).toThrow(CanonicalDataError);
  });
});
