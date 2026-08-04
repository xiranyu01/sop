import { create, type JsonValue } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import {
  ContactSchema,
  CustomerSchema,
  GlobalFieldSchema,
  MaterialSchema,
  MaterialStateRuleSchema,
  RobotModelSchema,
  SceneSchema,
  TopicAdditionalRequirementSchema,
  TopicBindingSchema,
  type Customer as CustomerMessage,
  type GlobalField as GlobalFieldMessage,
  type Material as MaterialMessage,
  type MaterialStateRule as MaterialStateRuleMessage,
  type RobotModel as RobotModelMessage,
  type Scene as SceneMessage,
} from '../../gen/coscene/sop/v1alpha1/catalog_pb';
import {
  GlobalFieldGroup as ProtoGlobalFieldGroup,
  GlobalFieldStatus as ProtoGlobalFieldStatus,
} from '../../gen/coscene/sop/v1alpha1/common_pb';
import { fromDomainJson, toDomainJson } from '../../shared/domain/codec';
import type {
  Customer,
  GlobalField,
  GlobalFieldGroup,
  Material,
  MaterialStateRule,
  RequirementAttachment,
  RobotModel,
  Scene,
} from './viewModels';

export type MutableResourceForm<T, Message> = {
  name: string;
  uid: string;
  etag: string;
  value: T;
  message: Message;
};

export type AttachmentFormResolver = {
  byName(name: string): RequirementAttachment | undefined;
  nameById(id: string): string | undefined;
};

const groupToForm: Record<number, GlobalFieldGroup> = {
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
  [ProtoGlobalFieldGroup.ATOMIC_SKILL]: 'atomic_skill',
};

const groupToProto = Object.fromEntries(
  Object.entries(groupToForm).map(([key, value]) => [value, Number(key)]),
) as Record<GlobalFieldGroup, ProtoGlobalFieldGroup>;

function sourceId(message: { sourceId?: string; name: string }): string {
  return message.sourceId || message.name.split('/').at(-1) || message.name;
}

function iso(message: { updateTime?: Parameters<typeof timestampDate>[0] }): string {
  return message.updateTime ? timestampDate(message.updateTime).toISOString() : new Date(0).toISOString();
}

function wrap<T, Message extends { name: string; uid: string; etag: string }>(
  message: Message,
  value: T,
): MutableResourceForm<T, Message> {
  return { name: message.name, uid: message.uid, etag: message.etag, value, message };
}

export function decodeCustomerForm(resource: JsonValue): MutableResourceForm<Customer, CustomerMessage> {
  const message = fromDomainJson(CustomerSchema, resource);
  return wrap(message, {
    id: sourceId(message),
    name: message.displayName,
    contact: {
      name: message.primaryContact?.displayName || '',
      phone: message.primaryContact?.phone || '',
      email: message.primaryContact?.email || '',
    },
    notes: message.notes,
  });
}

export function encodeCustomerForm(form: Customer, current: CustomerMessage): JsonValue {
  return toDomainJson(CustomerSchema, create(CustomerSchema, {
    ...current,
    displayName: form.name,
    sourceId: current.sourceId || form.id,
    primaryContact: create(ContactSchema, {
      displayName: form.contact.name || undefined,
      phone: form.contact.phone || undefined,
      email: form.contact.email || undefined,
    }),
    notes: form.notes || undefined,
  }));
}

export function createCustomerResource(form: Customer): JsonValue {
  return encodeCustomerForm(form, create(CustomerSchema));
}

export function decodeMaterialForm(
  resource: JsonValue,
  attachments?: AttachmentFormResolver,
): MutableResourceForm<Material, MaterialMessage> {
  const message = fromDomainJson(MaterialSchema, resource);
  return wrap(message, {
    id: sourceId(message),
    skuId: message.sku || '',
    type: message.category || message.displayName,
    color: message.colors[0] || '',
    material: message.compositions[0] || '',
    packageType: message.packaging || '',
    size: message.size,
    weight: message.weight,
    images: attachments ? message.images.flatMap((name) => attachments.byName(name) ?? []) : [],
  });
}

export function encodeMaterialForm(
  form: Material,
  current: MaterialMessage,
  attachments?: AttachmentFormResolver,
): JsonValue {
  const images = attachments
    ? (form.images ?? []).flatMap((attachment) => attachments.nameById(attachment.id) ?? [])
    : current.images;
  return toDomainJson(MaterialSchema, create(MaterialSchema, {
    ...current,
    displayName: form.type || form.skuId,
    sourceId: current.sourceId || form.id,
    sku: form.skuId || undefined,
    category: form.type || undefined,
    colors: form.color ? [form.color] : [],
    compositions: form.material ? [form.material] : [],
    packaging: form.packageType || undefined,
    size: form.size || undefined,
    weight: form.weight || undefined,
    images,
  }));
}

export function createMaterialResource(form: Material): JsonValue {
  return encodeMaterialForm(form, create(MaterialSchema));
}

export function decodeRobotModelForm(resource: JsonValue): MutableResourceForm<RobotModel, RobotModelMessage> {
  const message = fromDomainJson(RobotModelSchema, resource);
  return wrap(message, {
    id: sourceId(message),
    brand: message.manufacturer || '',
    model: message.modelCode || '',
    terminal: message.endEffector || '',
    topics: Object.fromEntries(message.topics.map((topic) => [topic.id, topic.topic])),
    extraTopicRequirements: Object.fromEntries(
      message.extraTopicRequirements.map((item) => [item.topicId, item.requirement]),
    ),
  });
}

export function encodeRobotModelForm(form: RobotModel, current: RobotModelMessage): JsonValue {
  return toDomainJson(RobotModelSchema, create(RobotModelSchema, {
    ...current,
    displayName: [form.brand, form.model].filter(Boolean).join(' ') || form.id,
    sourceId: current.sourceId || form.id,
    manufacturer: form.brand || undefined,
    modelCode: form.model || undefined,
    endEffector: form.terminal || undefined,
    topics: Object.entries(form.topics).sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([id, topic]) => create(TopicBindingSchema, { id, topic })),
    extraTopicRequirements: Object.entries(form.extraTopicRequirements)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([topicId, requirement]) => create(TopicAdditionalRequirementSchema, { topicId, requirement })),
  }));
}

export function createRobotModelResource(form: RobotModel): JsonValue {
  return encodeRobotModelForm(form, create(RobotModelSchema));
}

export function decodeSceneForm(resource: JsonValue): MutableResourceForm<Scene, SceneMessage> {
  const message = fromDomainJson(SceneSchema, resource);
  return wrap(message, {
    id: sourceId(message),
    name: message.displayName,
    description: message.description || '',
    // TaskSops are loaded through their own summary/revision endpoints.
    subscenes: [],
  });
}

export function encodeSceneForm(form: Scene, current: SceneMessage): JsonValue {
  return toDomainJson(SceneSchema, create(SceneSchema, {
    ...current,
    displayName: form.name,
    sourceId: current.sourceId || form.id,
    description: form.description || undefined,
  }));
}

export function createSceneResource(form: Scene): JsonValue {
  return encodeSceneForm(form, create(SceneSchema));
}

export function decodeGlobalFieldForm(resource: JsonValue): MutableResourceForm<GlobalField, GlobalFieldMessage> {
  const message = fromDomainJson(GlobalFieldSchema, resource);
  const group = groupToForm[message.group];
  if (!group) throw new Error(`Unsupported GlobalField group ${message.group}`);
  return wrap(message, {
    id: sourceId(message),
    group,
    label: message.label,
    value: message.value,
    category: message.category,
    description: message.description,
    startCondition: message.startCondition,
    endCondition: message.endCondition,
    status: message.status === ProtoGlobalFieldStatus.INACTIVE ? 'inactive' : 'active',
    updatedAt: iso(message),
  });
}

export function encodeGlobalFieldForm(form: GlobalField, current: GlobalFieldMessage): JsonValue {
  return toDomainJson(GlobalFieldSchema, create(GlobalFieldSchema, {
    ...current,
    sourceId: current.sourceId || form.id,
    group: groupToProto[form.group],
    label: form.label,
    value: form.value,
    category: form.category || undefined,
    description: form.description || undefined,
    startCondition: form.startCondition || undefined,
    endCondition: form.endCondition || undefined,
    status: form.status === 'inactive' ? ProtoGlobalFieldStatus.INACTIVE : ProtoGlobalFieldStatus.ACTIVE,
  }));
}

export function createGlobalFieldResource(form: GlobalField): JsonValue {
  return encodeGlobalFieldForm(form, create(GlobalFieldSchema));
}

export function decodeMaterialStateRuleForm(
  resource: JsonValue,
): MutableResourceForm<MaterialStateRule, MaterialStateRuleMessage> {
  const message = fromDomainJson(MaterialStateRuleSchema, resource);
  return wrap(message, {
    id: sourceId(message),
    materialType: message.materialType,
    primaryReferences: [...message.primaryReferences],
    primaryRelativePositions: [...message.primaryRelativePositions],
    supportSurfaces: [...message.supportSurfaces],
    regions: [...message.regions],
    secondaryReferences: [...message.secondaryReferences],
    secondaryRelativePositions: [...message.secondaryRelativePositions],
    poses: [...message.poses],
    forms: [...message.forms],
    parameters: [...message.parameters],
    updatedAt: iso(message),
  });
}

export function encodeMaterialStateRuleForm(
  form: MaterialStateRule,
  current: MaterialStateRuleMessage,
): JsonValue {
  return toDomainJson(MaterialStateRuleSchema, create(MaterialStateRuleSchema, {
    ...current,
    sourceId: current.sourceId || form.id,
    materialType: form.materialType,
    primaryReferences: form.primaryReferences,
    primaryRelativePositions: form.primaryRelativePositions,
    supportSurfaces: form.supportSurfaces,
    regions: form.regions,
    secondaryReferences: form.secondaryReferences,
    secondaryRelativePositions: form.secondaryRelativePositions,
    poses: form.poses,
    forms: form.forms,
    parameters: form.parameters,
  }));
}

export function createMaterialStateRuleResource(form: MaterialStateRule): JsonValue {
  return encodeMaterialStateRuleForm(form, create(MaterialStateRuleSchema));
}
