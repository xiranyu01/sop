export type OperationOutcome = 'success' | 'rejected' | 'failure';

export type OperationLogEvent = {
  requestId: string;
  operation: string;
  outcome: OperationOutcome;
  durationMs: number;
  resourceKind?: string;
  resourceName?: string;
  failureClass?: string;
  conflictOutcome?: string;
  confirmationOutcome?: string;
  reviewOutcome?: string;
  bootstrapOutcome?: string;
  rowSizeOutcome?: 'warning' | 'rejected';
  measuredBytes?: number;
};

export type LogSink = { log(message: string): void };

const allowedKeys: Array<keyof OperationLogEvent> = [
  'requestId', 'operation', 'outcome', 'durationMs', 'resourceKind', 'resourceName',
  'failureClass', 'conflictOutcome', 'confirmationOutcome', 'reviewOutcome',
  'bootstrapOutcome', 'rowSizeOutcome', 'measuredBytes',
];

export function serializeOperationLog(event: OperationLogEvent): string {
  const safe: Partial<OperationLogEvent> & { event: string } = { event: 'sop_operation' };
  for (const key of allowedKeys) {
    const value = event[key];
    if (value !== undefined) (safe as Record<string, unknown>)[key] = value;
  }
  return JSON.stringify(safe);
}

export function logOperation(sink: LogSink, event: OperationLogEvent): void {
  sink.log(serializeOperationLog(event));
}

