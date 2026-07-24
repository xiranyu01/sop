import { describe, expect, it } from 'vitest';
import { bulkDraftToSteps, operationStepsReadyToSave, stepsToBulkDraft } from '../../src/domain/bulkSteps';
import type { OperationStep } from '../../src/domain/viewModels';

const existingSteps: OperationStep[] = [
  {
    order: 1,
    description: '拿起牙刷',
    atomicSkill: '抓取',
    englishDescription: 'Pick up the toothbrush',
    englishAtomicSkill: 'Pick',
  },
  {
    order: 2,
    description: '放入牙刷杯',
    atomicSkill: '放置',
    englishDescription: 'Place it in the cup',
    englishAtomicSkill: 'Place',
  },
];

describe('bulk step editing', () => {
  it('fills all four bulk-edit columns from existing steps', () => {
    expect(stepsToBulkDraft(existingSteps)).toEqual({
      description: '拿起牙刷\n放入牙刷杯',
      atomicSkill: '抓取\n放置',
      englishDescription: 'Pick up the toothbrush\nPlace it in the cup',
      englishAtomicSkill: 'Pick\nPlace',
    });
  });

  it('replaces an edited row instead of appending duplicate steps', () => {
    const draft = stepsToBulkDraft(existingSteps);
    draft.description = '拿起洗脸巾\n放入收纳盒';

    expect(bulkDraftToSteps(draft)).toHaveLength(2);
    expect(bulkDraftToSteps(draft).map((step) => step.description)).toEqual(['拿起洗脸巾', '放入收纳盒']);
  });

  it('removes blank rows and renumbers the remaining steps', () => {
    const draft = stepsToBulkDraft(existingSteps);
    draft.description = '\n放入牙刷杯';
    draft.atomicSkill = '\n放置';
    draft.englishDescription = '\nPlace it in the cup';
    draft.englishAtomicSkill = '\nPlace';

    expect(bulkDraftToSteps(draft)).toEqual([{ ...existingSteps[1], order: 1 }]);
  });

  it('merges Chinese and English columns by line number when their lengths differ', () => {
    expect(bulkDraftToSteps({
      description: '第一步\n第二步\n第三步',
      atomicSkill: '抓取',
      englishDescription: 'First step\nSecond step',
      englishAtomicSkill: '',
    })).toEqual([
      { order: 1, description: '第一步', atomicSkill: '抓取', englishDescription: 'First step', englishAtomicSkill: '' },
      { order: 2, description: '第二步', atomicSkill: '', englishDescription: 'Second step', englishAtomicSkill: '' },
      { order: 3, description: '第三步', atomicSkill: '', englishDescription: '', englishAtomicSkill: '' },
    ]);
  });

  it('uses the same conversion for collection and annotation steps', () => {
    const collectionSteps = bulkDraftToSteps(stepsToBulkDraft(existingSteps));
    const annotationSteps = bulkDraftToSteps(stepsToBulkDraft(existingSteps));

    expect(collectionSteps).toEqual(annotationSteps);
  });

  it('keeps incomplete new rows local until their Chinese description is filled', () => {
    expect(operationStepsReadyToSave(existingSteps)).toBe(true);
    expect(operationStepsReadyToSave([
      ...existingSteps,
      { order: 3, description: '', atomicSkill: '抓取' },
    ])).toBe(false);
    expect(operationStepsReadyToSave([])).toBe(true);
  });
});
