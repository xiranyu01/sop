export class CanonicalStoreError extends Error {}

export class CanonicalDataError extends CanonicalStoreError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CanonicalDataError';
  }
}

export class NamespaceNotFoundError extends CanonicalStoreError {
  constructor(namespace: string) {
    super(`Canonical namespace not found: ${namespace}`);
    this.name = 'NamespaceNotFoundError';
  }
}

export class StaleStoreEpochError extends CanonicalStoreError {
  constructor(namespace: string, expectedEpoch: number, actualEpoch?: number) {
    super(`Stale canonical store epoch for ${namespace}: expected ${expectedEpoch}${actualEpoch === undefined ? '' : `, actual ${actualEpoch}`}`);
    this.name = 'StaleStoreEpochError';
  }
}

export class WriteFrozenError extends CanonicalStoreError {
  constructor(namespace: string) {
    super(`Canonical namespace is write-frozen: ${namespace}`);
    this.name = 'WriteFrozenError';
  }
}

export class AtomicCommitError extends CanonicalStoreError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'AtomicCommitError';
  }
}

