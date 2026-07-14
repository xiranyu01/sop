export const ROW_SIZE_WARNING_BYTES = 1_500_000;
export const ROW_SIZE_REJECTION_BYTES = 1_800_000;

export type VariableLengthValue = string | Uint8Array | null | undefined;

export type RowSizeAssessment = {
  resourceKind: string;
  resourceName: string;
  bytes: number;
  warning: boolean;
};

export type RowSizeWarning = RowSizeAssessment & {
  warningLimitBytes: typeof ROW_SIZE_WARNING_BYTES;
  rejectionLimitBytes: typeof ROW_SIZE_REJECTION_BYTES;
};

export class RowSizeLimitError extends Error {
  readonly code = 'ROW_SIZE_LIMIT' as const;

  constructor(
    readonly resourceKind: string,
    readonly resourceName: string,
    readonly bytes: number,
    readonly limitBytes = ROW_SIZE_REJECTION_BYTES,
  ) {
    super(`${resourceKind} ${resourceName} requires ${bytes} variable bytes; limit is ${limitBytes}`);
    this.name = 'RowSizeLimitError';
  }
}

const encoder = new TextEncoder();

export function variableLengthBytes(value: VariableLengthValue): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'string' ? encoder.encode(value).byteLength : value.byteLength;
}

export function measureVariableLengthColumns(
  columns: Readonly<Record<string, VariableLengthValue>>,
): number {
  return Object.values(columns).reduce((total, value) => total + variableLengthBytes(value), 0);
}

/**
 * Merge a partial update with the stored variable-length columns before
 * measuring it. This prevents a small patch from ignoring large unchanged
 * ProtoJSON/metadata columns in the prospective D1 row.
 */
export function prospectiveVariableLengthColumns(
  stored: Readonly<Record<string, VariableLengthValue>>,
  patch: Readonly<Record<string, VariableLengthValue>>,
): Record<string, VariableLengthValue> {
  return { ...stored, ...patch };
}

export function guardProspectiveRow(
  resourceKind: string,
  resourceName: string,
  columns: Readonly<Record<string, VariableLengthValue>>,
  onWarning?: (warning: RowSizeWarning) => void,
): RowSizeAssessment {
  const bytes = measureVariableLengthColumns(columns);
  if (bytes >= ROW_SIZE_REJECTION_BYTES) {
    throw new RowSizeLimitError(resourceKind, resourceName, bytes);
  }
  const warning = bytes >= ROW_SIZE_WARNING_BYTES;
  if (warning) {
    onWarning?.({
      resourceKind,
      resourceName,
      bytes,
      warning: true,
      warningLimitBytes: ROW_SIZE_WARNING_BYTES,
      rejectionLimitBytes: ROW_SIZE_REJECTION_BYTES,
    });
  }
  return { resourceKind, resourceName, bytes, warning };
}
