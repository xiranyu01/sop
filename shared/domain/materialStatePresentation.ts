export type MaterialStateSentenceInput = {
  object: string;
  primaryReference?: string;
  primaryRelativePosition?: string;
  supportSurface?: string;
  regions?: string[];
  secondaryReference?: string;
  secondaryRelativePosition?: string;
  poses?: string[];
  forms?: string[];
  parameters?: string[];
};

export function materialStateSentence(input: MaterialStateSentenceInput): string {
  const parts = [`把 ${input.object || '物料'}`];
  const primary = [input.primaryReference, input.primaryRelativePosition].filter(Boolean).join('的');
  if (primary) parts.push(`放在 ${primary}`);
  if (input.supportSurface) parts.push(`接触 ${input.supportSurface}`);
  if (input.regions?.length) parts.push(`区域为 ${input.regions.join('、')}`);
  const secondary = [input.secondaryReference, input.secondaryRelativePosition].filter(Boolean).join('的');
  if (secondary) parts.push(`更具体位置为 ${secondary}`);
  if (input.poses?.length) parts.push(`姿态为 ${input.poses.join('、')}`);
  if (input.forms?.length) parts.push(`形态为 ${input.forms.join('、')}`);
  if (input.parameters?.length) parts.push(`参数为 ${input.parameters.join('、')}`);
  return `${parts.join('，')}。`;
}
