import { create } from '@bufbuild/protobuf';
import { DurationSchema, type Duration } from '@bufbuild/protobuf/wkt';
import {
  ChangeFrequency as ProtoChangeFrequency,
  GlobalFieldGroup as ProtoGlobalFieldGroup,
  GlobalFieldStatus as ProtoGlobalFieldStatus,
  Lifecycle as ProtoLifecycle,
  OperationStepSchema,
  Priority as ProtoPriority,
  type OperationStep as ProtoOperationStep,
} from '../../gen/coscene/sop/v1alpha1/common_pb';
import { DateSchema, type Date as ProtoDate } from '../../gen/google/type/date_pb';
import type {
  ChangeFrequency,
  EntityStatus,
  GlobalFieldGroup,
  GlobalFieldStatus,
  OperationStep,
  Priority,
} from '../../shared/transport/restDto';

const lifecycleTokens: Readonly<Record<number, EntityStatus>> = {
  [ProtoLifecycle.DRAFT]: 'draft',
  [ProtoLifecycle.CONFIRMED]: 'confirmed',
  [ProtoLifecycle.ARCHIVED]: 'archived',
};
const priorityTokens: Readonly<Record<number, Priority>> = {
  [ProtoPriority.P0]: 'P0', [ProtoPriority.P1]: 'P1', [ProtoPriority.P2]: 'P2', [ProtoPriority.P3]: 'P3',
};
const changeFrequencyTokens: Readonly<Record<number, ChangeFrequency>> = {
  [ProtoChangeFrequency.EVERY_RECORD]: 'every_record',
  [ProtoChangeFrequency.EVERY_N_RECORDS]: 'every_n_records',
  [ProtoChangeFrequency.PER_BATCH]: 'per_batch',
  [ProtoChangeFrequency.FIXED]: 'fixed',
};
const globalFieldStatusTokens: Readonly<Record<number, GlobalFieldStatus>> = {
  [ProtoGlobalFieldStatus.ACTIVE]: 'active', [ProtoGlobalFieldStatus.INACTIVE]: 'inactive',
};
const globalFieldGroupTokens: Readonly<Record<number, GlobalFieldGroup>> = {
  [ProtoGlobalFieldGroup.ROBOT_STATE]: 'robot_state',
  [ProtoGlobalFieldGroup.REFERENCE_OBJECT]: 'reference_object',
  [ProtoGlobalFieldGroup.RELATIVE_POSITION]: 'relative_position',
  [ProtoGlobalFieldGroup.SUPPORT_SURFACE]: 'support_surface',
  [ProtoGlobalFieldGroup.REGION]: 'region',
  [ProtoGlobalFieldGroup.POSE]: 'pose',
  [ProtoGlobalFieldGroup.FORM]: 'form',
  [ProtoGlobalFieldGroup.PARAMETER]: 'parameter',
  [ProtoGlobalFieldGroup.ALLOWED_OPERATION]: 'allowed_operation',
  [ProtoGlobalFieldGroup.ACCEPTABLE_OPERATION]: 'acceptable_operation',
  [ProtoGlobalFieldGroup.FORBIDDEN_OPERATION]: 'forbidden_operation',
  [ProtoGlobalFieldGroup.ANNOTATION_ALLOWED_OPERATION]: 'annotation_allowed_operation',
  [ProtoGlobalFieldGroup.ANNOTATION_FORBIDDEN_OPERATION]: 'annotation_forbidden_operation',
  [ProtoGlobalFieldGroup.RANDOM_FIELD]: 'random_field',
  [ProtoGlobalFieldGroup.ROBOT_RANDOM_FIELD]: 'robot_random_field',
  [ProtoGlobalFieldGroup.MATERIAL_RANDOM_FIELD]: 'material_random_field',
  [ProtoGlobalFieldGroup.ANNOTATION_TYPE]: 'annotation_type',
  [ProtoGlobalFieldGroup.DELIVERY_FORMAT]: 'delivery_format',
  [ProtoGlobalFieldGroup.DELIVERY_LANGUAGE]: 'delivery_language',
  [ProtoGlobalFieldGroup.DELIVERY_METHOD]: 'delivery_method',
  [ProtoGlobalFieldGroup.SAMPLING_POLICY]: 'sampling_policy',
};

function enumToken<T extends string>(value: number, tokens: Readonly<Record<number, T>>, name: string): T {
  const token = tokens[value];
  if (token === undefined) throw new Error(`${name} cannot be unspecified or unknown: ${value}`);
  return token;
}

function protoEnum<T extends string>(token: T, tokens: Readonly<Record<number, T>>, name: string): number {
  for (const [value, candidate] of Object.entries(tokens)) if (candidate === token) return Number(value);
  throw new Error(`${name} token is unknown: ${token}`);
}

export const lifecycleView = {
  fromProto: (value: ProtoLifecycle): EntityStatus => enumToken(value, lifecycleTokens, 'Lifecycle'),
  toProto: (token: EntityStatus): ProtoLifecycle => protoEnum(token, lifecycleTokens, 'Lifecycle') as ProtoLifecycle,
};
export const priorityView = {
  fromProto: (value: ProtoPriority): Priority => enumToken(value, priorityTokens, 'Priority'),
  toProto: (token: Priority): ProtoPriority => protoEnum(token, priorityTokens, 'Priority') as ProtoPriority,
};
export const changeFrequencyView = {
  fromProto: (value: ProtoChangeFrequency): ChangeFrequency => enumToken(value, changeFrequencyTokens, 'ChangeFrequency'),
  toProto: (token: ChangeFrequency): ProtoChangeFrequency => protoEnum(token, changeFrequencyTokens, 'ChangeFrequency') as ProtoChangeFrequency,
};
export const globalFieldStatusView = {
  fromProto: (value: ProtoGlobalFieldStatus): GlobalFieldStatus => enumToken(value, globalFieldStatusTokens, 'GlobalFieldStatus'),
  toProto: (token: GlobalFieldStatus): ProtoGlobalFieldStatus => protoEnum(token, globalFieldStatusTokens, 'GlobalFieldStatus') as ProtoGlobalFieldStatus,
};
export const globalFieldGroupView = {
  fromProto: (value: ProtoGlobalFieldGroup): GlobalFieldGroup => enumToken(value, globalFieldGroupTokens, 'GlobalFieldGroup'),
  toProto: (token: GlobalFieldGroup): ProtoGlobalFieldGroup => protoEnum(token, globalFieldGroupTokens, 'GlobalFieldGroup') as ProtoGlobalFieldGroup,
};

function optionalText(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

export const operationStepView = {
  fromProto(step: ProtoOperationStep): OperationStep {
    return {
      order: step.order, description: step.description, atomicSkill: step.atomicSkill,
      englishDescription: step.englishDescription, englishAtomicSkill: step.englishAtomicSkill,
    };
  },
  toProto(step: OperationStep, id: string): ProtoOperationStep {
    return create(OperationStepSchema, {
      id, order: step.order, description: step.description, atomicSkill: optionalText(step.atomicSkill),
      englishDescription: optionalText(step.englishDescription), englishAtomicSkill: optionalText(step.englishAtomicSkill),
    });
  },
};

export const dateView = {
  fromProto(value: ProtoDate | undefined): string {
    if (!value) return '';
    return `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
  },
  toProto(value: string): ProtoDate | undefined {
    if (value === '') return undefined;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) throw new Error(`Date must use YYYY-MM-DD: ${value}`);
    const [, yearText, monthText, dayText] = match;
    const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
    const date = new globalThis.Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
      throw new Error(`Date is not a calendar date: ${value}`);
    }
    return create(DateSchema, { year, month, day });
  },
};

export const durationHoursView = {
  fromProto(value: Duration | undefined): number {
    return value ? (Number(value.seconds) + value.nanos / 1_000_000_000) / 3600 : 0;
  },
  toProto(hours: number): Duration | undefined {
    if (hours === 0) return undefined;
    if (!Number.isFinite(hours) || hours < 0) throw new Error(`Duration hours must be finite and non-negative: ${hours}`);
    let seconds = Math.trunc(hours * 3600);
    let nanos = Math.round((hours * 3600 - seconds) * 1_000_000_000);
    if (nanos === 1_000_000_000) { seconds += 1; nanos = 0; }
    if (!Number.isSafeInteger(seconds)) throw new Error(`Duration hours exceed the safe UI range: ${hours}`);
    return create(DurationSchema, { seconds: BigInt(seconds), nanos });
  },
};

export const collectionCountView = {
  fromProto(value: bigint | undefined): number {
    if (value === undefined) return 0;
    const count = Number(value);
    if (!Number.isSafeInteger(count)) throw new Error(`Collection count exceeds the safe UI range: ${value}`);
    return count;
  },
  toProto(value: number): bigint | undefined {
    if (value === 0) return undefined;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Collection count must be a non-negative safe integer: ${value}`);
    return BigInt(value);
  },
};
