const legacySyntheticMaterialRandomizationConstraints = new Set([
  '每次采集前需要改变位置',
  '仍需满足 object_states.initial 中定义的允许状态',
]);

export function removeLegacySyntheticMaterialRandomizationConstraints(values: readonly string[]): string[] {
  return values.filter((value) => !legacySyntheticMaterialRandomizationConstraints.has(value));
}
