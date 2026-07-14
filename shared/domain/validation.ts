import { type DescMessage, type MessageShape, type MessageValidType } from '@bufbuild/protobuf';
import { pathToString } from '@bufbuild/protobuf/reflect';
import { createValidator, type Validator } from '@bufbuild/protovalidate';

export type DomainViolation = {
  fieldPath: string;
  message: string;
  ruleId: string;
  forKey: boolean;
};

export class DomainValidationError extends Error {
  readonly violations: DomainViolation[];

  constructor(violations: DomainViolation[]) {
    super(violations.map((item) => `${item.fieldPath || '$'}: ${item.message}`).join('; '));
    this.name = 'DomainValidationError';
    this.violations = violations;
  }
}

export class DomainValidatorRuntimeError extends Error {
  constructor(cause: unknown) {
    super(`Domain validator failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'DomainValidatorRuntimeError';
  }
}

const sharedValidator = createValidator();

export function validateDomainMessage<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
  validator: Validator = sharedValidator,
): { ok: true; message: MessageValidType<Desc> } | { ok: false; violations: DomainViolation[] } {
  const result = validator.validate(schema, message);
  if (result.kind === 'error') throw new DomainValidatorRuntimeError(result.error);
  if (result.kind === 'valid') return { ok: true, message: result.message };
  return {
    ok: false,
    violations: result.violations.map((violation) => ({
      fieldPath: pathToString(violation.field),
      message: violation.message,
      ruleId: violation.ruleId,
      forKey: violation.forKey,
    })),
  };
}

export function assertValidDomainMessage<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
  validator: Validator = sharedValidator,
): MessageValidType<Desc> {
  const result = validateDomainMessage(schema, message, validator);
  if (!result.ok) throw new DomainValidationError(result.violations);
  return result.message;
}
