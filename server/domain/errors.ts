export class CanonicalStoreError extends Error {}

export class CanonicalDataError extends CanonicalStoreError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CanonicalDataError';
  }
}

export class ExportNotFoundError extends CanonicalStoreError {
  constructor(message: string) {
    super(message);
    this.name = 'ExportNotFoundError';
  }
}
