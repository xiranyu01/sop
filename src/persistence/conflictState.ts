export function copyLocalChanges(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

