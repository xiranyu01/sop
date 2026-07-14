import { describe, expect, it } from 'vitest';
import { projectCanonicalToRest } from '../../server/domain/services/projection';
import { convertLegacyToV1alpha1 } from '../../server/migrations/legacyToV1alpha1';
import { seedData } from '../e2e/fixtures/seed';

function firstTaskDraft() {
  const data = structuredClone(seedData);
  const version = data.scenes[0].subscenes[0].versions[0];
  version.status = 'draft';
  return { data, version };
}

describe('legacy draft reference conversion', () => {
  it('accepts unfinished empty object and image selections', () => {
    const { data, version } = firstTaskDraft();
    version.objectStates.initial = [{ object: '', allowedLocations: [{
      location: '', referencePath: [], supportSurface: '', allowedRegions: [], allowedPose: [], allowedForm: [],
      exampleImageAttachmentIds: [''], constraints: [],
    }] }];
    version.objectStates.target = [{
      object: '', requiredLocation: '', requiredRegions: [], requiredPose: [], requiredForm: [],
      exampleImageAttachmentIds: [''], constraints: [],
    }];
    version.randomization.materialInitialState.rules = [{
      targetMaterials: [''], changeFrequency: 'fixed',
      randomizedFields: { locations: [], poses: [], forms: [] },
      exampleImageAttachmentIds: [''], constraints: [],
    }];
    version.randomization.materialStateDuringOperation = { rules: [{
      targetMaterial: '', changeFrequency: 'fixed', randomizedFields: { parameters: [] },
    }] };

    const result = convertLegacyToV1alpha1(data);

    expect(result.report.issues.filter((issue) => issue.code === 'UNRESOLVED_REFERENCE')).toEqual([]);
    expect(result.report.ok).toBe(true);
    const projected = projectCanonicalToRest(result.snapshot).scenes[0].subscenes[0].versions[0];
    expect(projected.objectStates.initial[0].object).toBe('');
    expect(projected.objectStates.target[0].object).toBe('');
    expect(projected.randomization.materialInitialState.rules[0].targetMaterials).toEqual(['']);
    expect(projected.randomization.materialStateDuringOperation?.rules[0].targetMaterial).toBe('');
  });

  it('still rejects non-empty dangling object and image references', () => {
    const { data, version } = firstTaskDraft();
    version.objectStates.initial = [{ object: 'missing-object', allowedLocations: [{
      location: '', referencePath: [], supportSurface: '', allowedRegions: [], allowedPose: [], allowedForm: [],
      exampleImageAttachmentIds: ['missing-attachment'], constraints: [],
    }] }];

    const result = convertLegacyToV1alpha1(data);

    expect(result.report.ok).toBe(false);
    expect(result.report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNRESOLVED_REFERENCE', message: expect.stringContaining('missing-object') }),
      expect.objectContaining({ code: 'UNRESOLVED_REFERENCE', message: expect.stringContaining('missing-attachment') }),
    ]));
  });
});
