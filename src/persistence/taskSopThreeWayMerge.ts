export type TaskSopMergeConflict = {
  path: Array<string | number>;
  baseValue: unknown;
  localValue: unknown;
  remoteValue: unknown;
  reason: 'value' | 'delete-edit' | 'order' | 'unaddressable-list';
};

export type TaskSopMergeResult<T> = {
  value: T;
  conflicts: TaskSopMergeConflict[];
};

const missing = Symbol('missing');

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stableId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  for (const key of ['id', 'uid', 'name']) {
    if (typeof item[key] === 'string' && item[key]) return `${key}:${item[key]}`;
  }
  return undefined;
}

function mergeArrays(
  base: unknown[],
  local: unknown[],
  remote: unknown[],
  path: Array<string | number>,
  conflicts: TaskSopMergeConflict[],
): unknown[] {
  const baseIds = base.map(stableId);
  const localIds = local.map(stableId);
  const remoteIds = remote.map(stableId);
  if ([...baseIds, ...localIds, ...remoteIds].some((id) => !id)) {
    conflicts.push({ path, baseValue: base, localValue: local, remoteValue: remote, reason: 'unaddressable-list' });
    return local;
  }
  const baseOrder = baseIds.join('\u0000');
  const localOrder = localIds.join('\u0000');
  const remoteOrder = remoteIds.join('\u0000');
  if (localOrder !== baseOrder && remoteOrder !== baseOrder && localOrder !== remoteOrder) {
    conflicts.push({ path, baseValue: base, localValue: local, remoteValue: remote, reason: 'order' });
    return local;
  }
  const baseMap = new Map(baseIds.map((id, index) => [id!, base[index]]));
  const localMap = new Map(localIds.map((id, index) => [id!, local[index]]));
  const remoteMap = new Map(remoteIds.map((id, index) => [id!, remote[index]]));
  const order = localOrder !== baseOrder ? localIds as string[] : remoteIds as string[];
  const allIds = [...new Set([...order, ...localIds as string[], ...remoteIds as string[]])];
  const merged = new Map<string, unknown>();
  for (const id of allIds) {
    const baseItem = baseMap.has(id) ? baseMap.get(id) : missing;
    const localItem = localMap.has(id) ? localMap.get(id) : missing;
    const remoteItem = remoteMap.has(id) ? remoteMap.get(id) : missing;
    if (localItem === missing && remoteItem === missing) continue;
    if (baseItem !== missing && (localItem === missing || remoteItem === missing)) {
      const survivor = localItem === missing ? remoteItem : localItem;
      if (!equal(survivor, baseItem)) {
        conflicts.push({
          path: [...path, id],
          baseValue: baseItem,
          localValue: localItem === missing ? undefined : localItem,
          remoteValue: remoteItem === missing ? undefined : remoteItem,
          reason: 'delete-edit',
        });
        merged.set(id, localItem === missing ? remoteItem : localItem);
      }
      continue;
    }
    merged.set(id, mergeNode(baseItem, localItem, remoteItem, [...path, id], conflicts));
  }
  return allIds.filter((id) => merged.has(id)).map((id) => merged.get(id));
}

function mergeNode(
  base: unknown,
  local: unknown,
  remote: unknown,
  path: Array<string | number>,
  conflicts: TaskSopMergeConflict[],
): unknown {
  if (equal(local, base)) return remote;
  if (equal(remote, base)) return local;
  if (equal(local, remote)) return local;
  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
    return mergeArrays(base, local, remote, path, conflicts);
  }
  if (
    base && local && remote && typeof base === 'object' && typeof local === 'object' && typeof remote === 'object'
    && !Array.isArray(base) && !Array.isArray(local) && !Array.isArray(remote)
  ) {
    const result: Record<string, unknown> = {};
    const baseObject = base as Record<string, unknown>;
    const localObject = local as Record<string, unknown>;
    const remoteObject = remote as Record<string, unknown>;
    for (const key of new Set([...Object.keys(baseObject), ...Object.keys(localObject), ...Object.keys(remoteObject)])) {
      const baseValue = key in baseObject ? baseObject[key] : missing;
      const localValue = key in localObject ? localObject[key] : missing;
      const remoteValue = key in remoteObject ? remoteObject[key] : missing;
      if (localValue === missing && remoteValue === missing) continue;
      if (baseValue !== missing && (localValue === missing || remoteValue === missing)) {
        const survivor = localValue === missing ? remoteValue : localValue;
        if (equal(survivor, baseValue)) continue;
        conflicts.push({
          path: [...path, key],
          baseValue,
          localValue: localValue === missing ? undefined : localValue,
          remoteValue: remoteValue === missing ? undefined : remoteValue,
          reason: 'delete-edit',
        });
        if (localValue !== missing) result[key] = localValue;
        continue;
      }
      result[key] = mergeNode(baseValue, localValue, remoteValue, [...path, key], conflicts);
    }
    return result;
  }
  conflicts.push({ path, baseValue: base, localValue: local, remoteValue: remote, reason: 'value' });
  return local;
}

export function mergeTaskSopDraft<T>(base: T, local: T, remote: T): TaskSopMergeResult<T> {
  const conflicts: TaskSopMergeConflict[] = [];
  return { value: mergeNode(base, local, remote, [], conflicts) as T, conflicts };
}

export function setMergedValue<T>(root: T, path: Array<string | number>, value: unknown): T {
  if (path.length === 0) return value as T;
  const clone = structuredClone(root) as unknown;
  let cursor = clone as Record<string | number, unknown> | unknown[];
  for (const segment of path.slice(0, -1)) {
    if (Array.isArray(cursor) && typeof segment === 'string') {
      const index = cursor.findIndex((item) => stableId(item) === segment);
      if (index < 0) throw new Error(`Conflict item no longer exists: ${segment}`);
      cursor = cursor[index] as Record<string | number, unknown> | unknown[];
      continue;
    }
    const record = cursor as Record<string | number, unknown>;
    if (!record[segment] || typeof record[segment] !== 'object') record[segment] = {};
    cursor = record[segment] as Record<string | number, unknown> | unknown[];
  }
  const last = path.at(-1)!;
  if (Array.isArray(cursor) && typeof last === 'string') {
    const index = cursor.findIndex((item) => stableId(item) === last);
    if (value === undefined) {
      if (index >= 0) cursor.splice(index, 1);
    } else if (index >= 0) cursor[index] = value;
    else cursor.push(value);
  } else {
    const record = cursor as Record<string | number, unknown>;
    if (value === undefined) delete record[last];
    else record[last] = value;
  }
  return clone as T;
}
