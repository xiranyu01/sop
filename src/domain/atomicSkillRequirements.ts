import type { GlobalField, OperationStep, TextItem } from './viewModels';

function skillName(value: string | undefined): string {
  return value?.trim() || '';
}

export function atomicSkillRequirement(field: GlobalField): string | undefined {
  const name = skillName(field.label);
  const start = field.startCondition?.trim();
  const end = field.endCondition?.trim();
  if (field.group !== 'atomic_skill' || field.status !== 'active' || !name || !start || !end) return undefined;
  return `${name}：开始时机为${start}；结束时机为${end}`;
}

export function appendMissingAtomicSkillRequirements(
  steps: OperationStep[],
  requirements: TextItem[],
  globalFields: GlobalField[],
): TextItem[] {
  const skills = [...new Set(steps.map((step) => skillName(step.atomicSkill)).filter(Boolean))];
  if (skills.length === 0) return requirements;

  const fieldBySkill = new Map(
    globalFields
      .filter((field) => field.group === 'atomic_skill' && field.status === 'active')
      .map((field) => [skillName(field.label), field]),
  );
  const existingDescriptions = requirements.map((item) => item.description.trim());
  const additions = skills.flatMap((name) => {
    if (existingDescriptions.some((description) => description.startsWith(`${name}：`))) return [];
    const field = fieldBySkill.get(name);
    const description = field ? atomicSkillRequirement(field) : undefined;
    if (!description) return [];
    existingDescriptions.push(description);
    return [{ description }];
  });

  return additions.length > 0 ? [...requirements, ...additions] : requirements;
}
