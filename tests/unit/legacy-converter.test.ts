import { describe, expect, it } from 'vitest';
import { encodeCanonicalSnapshot } from '../../server/domain/appStore';
import { convertLegacyToV1alpha1 } from '../../server/migrations/legacyToV1alpha1';
import { readLegacyDirectory } from '../../server/migrations/runner';
import { deterministicUid } from '../../server/migrations/identity';

describe('legacy v1alpha1 converter', () => {
  it('allocates stable RFC UUIDv5 identities', () => {
    const uid = deterministicUid('customer', 'legacy-1');
    expect(deterministicUid('customer', 'legacy-1')).toBe(uid);
    expect(uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicUid('material', 'legacy-1')).not.toBe(uid);
  });

  it('maps the complete fixture deterministically without losing order, presence, or legacy-only values', async () => {
    const legacy = await readLegacyDirectory('data');
    const first = convertLegacyToV1alpha1(legacy);
    const second = convertLegacyToV1alpha1(structuredClone(legacy));

    expect(first.report).toEqual(second.report);
    expect(encodeCanonicalSnapshot(first.snapshot)).toBe(encodeCanonicalSnapshot(second.snapshot));
    expect(first.report.issues).toEqual([]);

    const microwave = first.snapshot.taskSopRevisions.find((revision) =>
      revision.snapshot?.legacySubsceneDisplayName === '将爆米花装入盒子');
    const parameter = microwave?.snapshot?.spec?.objectStates?.duringOperation[0]?.parameters[0];
    expect(parameter).toMatchObject({ name: 'door_open_angle', valueType: 'number', unit: 'degree' });
    expect(parameter?.sampling?.value).toEqual({ case: 'range', value: { $typeName: 'coscene.sop.v1alpha1.NumericRange', minValue: 30, maxValue: 90 } });
    expect(microwave?.snapshot?.spec?.randomization?.objectDuringOperation[0]?.parameterNames).toEqual(['door_open_angle', 'power', 'duration']);

    const task = first.snapshot.taskSopRevisions.find((revision) => revision.versionLabel === '0.0.2' && revision.snapshot?.displayName === '洗漱台整理');
    expect(task?.snapshot?.spec?.objects[0]?.quantity?.unit).toBe('件');
    expect(task?.snapshot?.spec?.materialStateRules.length).toBeGreaterThan(0);
    const externalReference = task?.snapshot?.spec?.objectStates?.initial[0]?.allowedLocations[0]?.referencePath[0];
    expect(externalReference?.referenceObject).toBe('洗手盆');
    expect(externalReference?.objectId).toBeUndefined();
    expect(task?.snapshot?.spec?.collection?.steps.map((step) => step.order)).toEqual([1, 2, 3, 4, 5]);

    const requirementWithZeroTarget = first.snapshot.requirementRevisions
      .filter((revision) => revision.name.startsWith('requirements/req-we-home/'))
      .flatMap((revision) => revision.snapshot?.spec?.productionItems ?? [])
      .find((item) => item.legacySubsceneName === '将爆米花装入盒子');
    expect(requirementWithZeroTarget?.target).toBeUndefined();
    expect(first.report.documentedNormalizations).toContain('selectedSubscenes[].targetDurationHours=0 is legacy unset and maps to absent WorkloadTarget.duration');
  });

  it('fails closed for ambiguous references and malformed persisted scalars', async () => {
    const legacy = await readLegacyDirectory('data');
    const duplicate = structuredClone(legacy.scenes[0].subscenes[0]);
    duplicate.code = 'NO.DUP';
    legacy.scenes[0].subscenes.push(duplicate);
    legacy.customers.push(structuredClone(legacy.customers[0]));
    legacy.globalFields[0].updatedAt = 'not-a-timestamp';
    legacy.materials[0].images = [{ id: 'bad', name: 'bad.bin', size: -1, contentType: 'application/octet-stream', storageKey: '', uploadedAt: 'bad' }];

    const { report } = convertLegacyToV1alpha1(legacy);
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['AMBIGUOUS_REFERENCE', 'COLLISION', 'INVALID_LEGACY_DATA']));
  });

  it('keeps source-position rule IDs, fractional duration precision, and indirect frozen attachments', async () => {
    const legacy = await readLegacyDirectory('data');
    const sourceVersion = legacy.scenes[0].subscenes[0].versions[0];
    sourceVersion.operation.allowedOperations = [
      { type: '', description: '' },
      { type: 'move', description: '保留的规则' },
    ];
    sourceVersion.requiredDurationHours = 0.0001;
    legacy.materials[0].images = [{
      id: 'material-image',
      name: 'material.png',
      size: 12,
      contentType: 'image/png',
      storageKey: 'materials/material.png',
      uploadedAt: '2026-01-01T00:00:00.000Z',
    }];

    const { snapshot, report } = convertLegacyToV1alpha1(legacy);
    expect(report.issues).toEqual([]);
    const revision = snapshot.taskSopRevisions.find((item) =>
      item.versionLabel === sourceVersion.version && item.snapshot?.legacySubsceneCode === legacy.scenes[0].subscenes[0].code);
    expect(revision?.snapshot?.spec?.collection?.policy?.allowed[0]?.id).toBe('allowed-2');
    expect(revision?.snapshot?.spec?.expectedDuration).toMatchObject({ seconds: 0n, nanos: 360_000_000 });
    expect(revision?.frozenDependencies?.attachments.map((item) => item.filename)).toContain('material.png');
  });
});
