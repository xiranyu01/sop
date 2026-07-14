import {
  create,
  fromJson,
  fromJsonString,
  toJson,
  type DescMessage,
  type JsonValue,
  type MessageInitShape,
  type MessageShape,
} from '@bufbuild/protobuf';

export class ProtoJsonDecodeError extends Error {
  readonly typeName: string;

  constructor(typeName: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Invalid ProtoJSON for ${typeName}: ${detail}`, { cause });
    this.name = 'ProtoJsonDecodeError';
    this.typeName = typeName;
  }
}

export function createDomainMessage<Desc extends DescMessage>(
  schema: Desc,
  init?: MessageInitShape<Desc>,
): MessageShape<Desc> {
  return create(schema, init);
}

export function fromDomainJson<Desc extends DescMessage>(schema: Desc, value: unknown): MessageShape<Desc> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtoJsonDecodeError(schema.typeName, new TypeError('expected a JSON object'));
  }
  try {
    // Unknown fields intentionally fail closed at every trust boundary.
    return fromJson(schema, value as JsonValue, { ignoreUnknownFields: false });
  } catch (error) {
    throw new ProtoJsonDecodeError(schema.typeName, error);
  }
}

export function fromDomainJsonString<Desc extends DescMessage>(schema: Desc, value: string): MessageShape<Desc> {
  try {
    // The string parser additionally rejects duplicate object keys.
    return fromJsonString(schema, value, { ignoreUnknownFields: false });
  } catch (error) {
    throw new ProtoJsonDecodeError(schema.typeName, error);
  }
}

export function toDomainJson<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>): JsonValue {
  return toJson(schema, message, {
    alwaysEmitImplicit: false,
    enumAsInteger: false,
    useProtoFieldName: false,
  });
}

