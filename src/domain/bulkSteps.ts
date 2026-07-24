import type { OperationStep } from './viewModels';

export type BulkStepsDraft = {
  description: string;
  atomicSkill: string;
  englishDescription: string;
  englishAtomicSkill: string;
};

const bulkStepFields: Array<keyof BulkStepsDraft> = [
  'description',
  'atomicSkill',
  'englishDescription',
  'englishAtomicSkill',
];

function splitLines(value: string): string[] {
  return value.replace(/\r\n/g, '\n').split('\n');
}

export function stepsToBulkDraft(steps: OperationStep[]): BulkStepsDraft {
  return {
    description: steps.map((step) => step.description || '').join('\n'),
    atomicSkill: steps.map((step) => step.atomicSkill || '').join('\n'),
    englishDescription: steps.map((step) => step.englishDescription || '').join('\n'),
    englishAtomicSkill: steps.map((step) => step.englishAtomicSkill || '').join('\n'),
  };
}

export function bulkDraftToSteps(draft: BulkStepsDraft): OperationStep[] {
  const columns = Object.fromEntries(
    bulkStepFields.map((field) => [field, splitLines(draft[field])]),
  ) as Record<keyof BulkStepsDraft, string[]>;
  const rowCount = Math.max(...bulkStepFields.map((field) => columns[field].length));

  return Array.from({ length: rowCount }, (_, index) => ({
    order: index + 1,
    description: columns.description[index]?.trim() || '',
    atomicSkill: columns.atomicSkill[index]?.trim() || '',
    englishDescription: columns.englishDescription[index]?.trim() || '',
    englishAtomicSkill: columns.englishAtomicSkill[index]?.trim() || '',
  }))
    .filter((step) => step.description || step.atomicSkill || step.englishDescription || step.englishAtomicSkill)
    .map((step, index) => ({ ...step, order: index + 1 }));
}

export function operationStepsReadyToSave(steps: OperationStep[]): boolean {
  return steps.every((step) => step.description.trim().length > 0);
}
