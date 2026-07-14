import { describe, expect, it } from 'vitest';
import {
  ChangeFrequency,
  GlobalFieldGroup,
  GlobalFieldStatus,
  Lifecycle,
  Priority,
} from '../../gen/coscene/sop/v1alpha1/common_pb';
import {
  changeFrequencyView,
  collectionCountView,
  dateView,
  durationHoursView,
  globalFieldGroupView,
  globalFieldStatusView,
  lifecycleView,
  operationStepView,
  priorityView,
} from '../../src/domain/protoFormMappings';
import { createEmptyAppViewModel, decodeAppViewModel } from '../../src/domain/viewModels';
import { emptyCanonicalSnapshot, encodeCanonicalSnapshot } from '../../server/domain/appStore';

describe('Proto-derived browser view models', () => {
  it('round-trips every form enum through the generated Proto values', () => {
    expect(lifecycleView.fromProto(Lifecycle.CONFIRMED)).toBe('confirmed');
    expect(lifecycleView.toProto('archived')).toBe(Lifecycle.ARCHIVED);
    expect(priorityView.fromProto(Priority.P1)).toBe('P1');
    expect(priorityView.toProto('P3')).toBe(Priority.P3);
    expect(changeFrequencyView.fromProto(ChangeFrequency.EVERY_N_RECORDS)).toBe('every_n_records');
    expect(changeFrequencyView.toProto('per_batch')).toBe(ChangeFrequency.PER_BATCH);
    expect(globalFieldStatusView.fromProto(GlobalFieldStatus.ACTIVE)).toBe('active');
    expect(globalFieldStatusView.toProto('inactive')).toBe(GlobalFieldStatus.INACTIVE);
    expect(globalFieldGroupView.fromProto(GlobalFieldGroup.DELIVERY_FORMAT)).toBe('delivery_format');
    expect(globalFieldGroupView.toProto('annotation_forbidden_operation')).toBe(
      GlobalFieldGroup.ANNOTATION_FORBIDDEN_OPERATION,
    );
  });

  it('fails closed for unspecified and unknown generated enum values', () => {
    expect(() => lifecycleView.fromProto(Lifecycle.UNSPECIFIED)).toThrow('cannot be unspecified or unknown');
    expect(() => globalFieldGroupView.fromProto(999 as GlobalFieldGroup)).toThrow('cannot be unspecified or unknown');
  });

  it('maps optional bilingual ordered steps without inventing Proto identity', () => {
    const proto = operationStepView.toProto(
      { order: 2, description: '放下杯子', atomicSkill: '', englishDescription: 'Place the cup' },
      'place-cup',
    );
    expect(proto).toMatchObject({
      id: 'place-cup',
      order: 2,
      description: '放下杯子',
      englishDescription: 'Place the cup',
    });
    expect(proto.atomicSkill).toBeUndefined();
    expect(operationStepView.fromProto(proto)).toEqual({
      order: 2,
      description: '放下杯子',
      atomicSkill: undefined,
      englishDescription: 'Place the cup',
      englishAtomicSkill: undefined,
    });
  });

  it('maps form dates, duration hours and int64 counts with explicit empty semantics', () => {
    expect(dateView.fromProto(dateView.toProto('2026-07-14'))).toBe('2026-07-14');
    expect(dateView.toProto('')).toBeUndefined();
    expect(() => dateView.toProto('2026-02-30')).toThrow('not a calendar date');
    expect(durationHoursView.fromProto(durationHoursView.toProto(1.000138888888889))).toBeCloseTo(1.000138888888889);
    expect(durationHoursView.toProto(0)).toBeUndefined();
    expect(collectionCountView.fromProto(collectionCountView.toProto(42))).toBe(42);
    expect(collectionCountView.toProto(0)).toBeUndefined();
    expect(() => collectionCountView.fromProto(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow('safe UI range');
  });

  it('creates independent empty projections and decodes a valid canonical Proto envelope', async () => {
    const first = createEmptyAppViewModel();
    const second = createEmptyAppViewModel();
    first.customers.push({ id: 'customer-1', name: 'ACME', contact: { name: '', phone: '', email: '' } });
    expect(second.customers).toEqual([]);
    const envelope = JSON.parse(encodeCanonicalSnapshot(emptyCanonicalSnapshot())) as unknown;
    await expect(decodeAppViewModel(envelope)).resolves.toEqual(createEmptyAppViewModel());
  });

  it('deep-validates generated resources before React state is updated', async () => {
    await expect(decodeAppViewModel(null)).rejects.toThrow('Invalid canonical app data envelope');
    const envelope = JSON.parse(encodeCanonicalSnapshot(emptyCanonicalSnapshot())) as {
      resources: Record<string, unknown[]>;
    };
    envelope.resources.customers.push({ name: 'INVALID RESOURCE NAME', unexpected: true });
    await expect(decodeAppViewModel(envelope)).rejects.toThrow('Malformed canonical snapshot');
  });
});
