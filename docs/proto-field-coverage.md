# Proto field coverage ledger

This ledger was the U2 completeness gate for the persisted application model and
remains the audit record for the deterministic converter. Its current transport
source is `shared/transport/restDto.ts`; coverage also includes editor bindings in
`src/App.tsx`, `server/api.ts`, and JSON fixtures under `data/`. `src/types.ts` was
removed after imports were moved to the explicit transport boundary. “Canonical
mapping” names the Proto field populated and reconciled by the implemented
legacy-to-v1alpha1 converter.

## Resource and catalog records

| Legacy record and fields | Canonical mapping | Classification |
| --- | --- | --- |
| `Customer.id` | `Customer.{name,uid,source_id}` | Domain identity plus exact compatibility provenance |
| `Customer.name`, `contact.{name,phone,email}`, `notes` | `Customer.display_name`, `primary_contact.{display_name,phone,email}`, `notes` | Domain |
| `Material.id` | `Material.{name,uid,source_id}` | Domain identity plus exact compatibility provenance |
| `Material.skuId`, `type`, `color`, `material`, `packageType` | `Material.{sku,category,colors,compositions,packaging}` | Domain |
| `Material.size`, `weight`, `images` | `Material.{size,weight,images}` and referenced `Attachment` metadata | Domain |
| `RobotModel.id` | `RobotModel.{name,uid,source_id}` | Domain identity plus exact compatibility provenance |
| `RobotModel.brand`, `model`, `terminal` | `RobotModel.{manufacturer,model_code,end_effector}` | Domain |
| `RobotModel.topics` map | ordered `RobotModel.topics` entries (`TopicBinding.id/topic`) | Domain; converter sorts keys |
| `RobotModel.extraTopicRequirements` map | ordered `RobotModel.extra_topic_requirements` | Domain; converter sorts keys |
| `GlobalField.id` | `GlobalField.{name,uid,source_id}` | Domain identity plus exact compatibility provenance |
| `GlobalField.group`, `label`, `value`, `category`, `description`, `status`, `updatedAt` | like-named `GlobalField` fields, typed group/status enums, `update_time` | Domain |
| `MaterialStateRule.id` | `MaterialStateRule.{name,uid,source_id}` | Domain identity plus exact compatibility provenance |
| all `MaterialStateRule` vocabulary arrays and `materialType`, `updatedAt` | like-named `MaterialStateRule` fields and `update_time` | Domain |
| `Scene.id`, `name`, `description` | `Scene.{name,uid,source_id,display_name,description}` | Domain |
| `Scene.subscenes[].code/name/versions` | separate `TaskSop` resources and `TaskSopRevision` chains linked by `TaskSop.scene` | Normalized domain |

Every item in the persisted `GlobalFieldGroup` union has a corresponding
`GLOBAL_FIELD_GROUP_*` enum value, including the currently hidden
`random_field` group. Active/inactive is represented by `GlobalFieldStatus`.

## Task SOP records

| Legacy fields | Canonical mapping | Classification |
| --- | --- | --- |
| `SubsceneVersion.version`, `versionId`, `parentVersionId`, `status`, `updatedAt` | `TaskSopRevision.{version_label,source_version_id,name,previous_revision,create_time}` and `TaskSop.lifecycle` | Revision domain; source version ID is explicit transport provenance and parent source ID is recovered through `previous_revision` |
| `title`, `sceneName`, `subsceneName`, `Subscene.code`, `description` | `TaskSop.{display_name,legacy_scene_display_name,legacy_subscene_display_name,legacy_subscene_code,description}` | Domain |
| `attachments` | `TaskSop.attachments` and frozen `Attachment` entries | Domain |
| `requiredDurationHours` | `TaskSopSpec.expected_duration` | Domain |
| each scenario material’s ID/SKU/type/quantity/color/composition/package | `TaskObject.{id,material,quantity,material_descriptor}` | Domain snapshot |
| `robotState.{initial,target}` | `RobotState.{initial,target}` | Domain |
| `robotOperationRequirements`, `robotInitialRandomizationRequirements`, `randomizationFrequency` | `TaskSopSpec.{robot_operation_requirements,robot_initial_randomization_requirements,legacy_randomization_frequency}` | Domain; the last field preserves legacy free text |
| robot randomization enabled/frequency/interval/fields | `RobotRandomization`, `ChangePolicy`, and `RandomizedField.{field_id,display_name,constraints}` | Domain |
| material randomization target materials/frequency/interval | `ObjectRandomization.{object_ids,change}` | Domain |
| material randomization locations/poses/forms (`name`, `valueSource`) | `ObjectRandomization.{locations,poses,forms}` using `NamedValueSource` | Domain |
| material randomization instruction/images/constraints | like-named `ObjectRandomization` fields | Domain |
| operation `stepOrder` and ordered steps (`order`, Chinese/English descriptions and skills) | `OperationPlan.step_order` and `OperationStep.{order,description,atomic_skill,english_description,english_atomic_skill}` | Domain; list order and explicit order are retained |
| operation allowed/acceptable/forbidden text items | `OperationPlan.policy` / `OperationRule` | Domain |
| initial object locations, ordered reference levels, source reference vocabulary, resolvable local object IDs, surfaces, regions, poses, forms, parameters, instructions, images, constraints | `InitialObjectState`, `LocationConstraint`, and `ReferenceRelation.{level,reference_object,object_id}` | Domain |
| target object required location and the same state vocabulary | `TargetObjectState.required_location` / `LocationConstraint` | Domain |
| runtime object parameters (`objectStates.duringOperation`) including value type, unit, allowed values, numeric sampling, and constraints | `DuringOperationObjectState` / `DuringOperationParameter` / `NumericSampling` | Domain |
| runtime material parameter randomization (`randomization.materialStateDuringOperation`) | `DuringOperationRandomization` with task-local object IDs, `ChangePolicy`, and parameter names | Domain |
| embedded `materialStateRules` | `TaskSopSpec.material_state_rules` | Frozen task-specific domain snapshot |
| annotation status/note/tags/steps/policies/randomization | `AnnotationPlan` | Domain |
| `references.recordUrls` | `TaskSop.reference_uris` | Domain external references |
| `references.attachments.{fileToken,name,size}` | `TaskSop.reference_attachments` / `LegacyReferenceAttachment` | Domain external-reference metadata |

## Requirement records

| Legacy fields | Canonical mapping | Classification |
| --- | --- | --- |
| `Requirement.id` | `Requirement.{name,uid,source_id}` | Domain identity plus exact compatibility provenance |
| version/version IDs/parent/status/updatedAt | `RequirementRevision.{version_label,source_version_id,name,previous_revision,create_time}` and `Requirement.lifecycle` | Revision domain; parent source ID is recovered through `previous_revision` |
| title/project/priority/deadline/source URL/business goal | `Requirement.{display_name}`, `RequirementSpec.{project_display_name,priority,deadline,source_uri,business_goal}` | Domain |
| `attachmentNotes`, `attachments` | `RequirementSpec.attachment_notes`, `Requirement.attachments`, frozen `Attachment` entries | Domain |
| `extraTopicRequirementsText` | `RequirementSpec.extra_topic_requirements_text` | Domain; raw text retained losslessly |
| global randomization/additional notes and topic constraints | `GlobalRequirements.{randomization_notes,additional_notes,topics}` | Domain |
| `customerId`, `robotModelId` | `RequirementSpec.customer` and pinned `robot_model_revision` | Normalized references |
| `requestedScenes` | `RequirementSpec.requested_scene_names` | Domain |
| aggregate duration/count | `RequirementSpec.aggregate_target` / `WorkloadTarget` | Domain |
| collection allowed/acceptable/categorized forbidden operations | `GlobalRequirements.collection_policy` / `OperationRule.{category,note}` | Domain |
| annotation required/types/allowed/forbidden | `AnnotationRequirements` plus `GlobalRequirements.annotation_policy` | Domain |
| quality required/sampling policy | `QualityInspectionRequirements` | Domain |
| delivery formats/method/data URL | `DeliveryRequirements` | Domain |
| delivery language `{code,name}` | `DeliveryLanguage.{code,display_name}` | Domain |
| selected subscene identity/title/description/scene/code/name/version/status and workload | `ProductionItem`, its canonical `task_sop_revision`, legacy identity fields, and `WorkloadTarget` | Domain and migration reference evidence |

## Attachment and envelope fields

`RequirementAttachment.{id,name,size,contentType,storageKey,uploadedAt}` maps to
`Attachment.{name,uid,source_id,filename,size_bytes,media_type,storage_key,create_time}`.
A public HTTPS value, when configured later, maps to `Attachment.uri`; it is not
fabricated during conversion. Upload-init values (`uploadId`, part size, maximum
size), upload-part ETags, HTTP authorization, and `ExportResult.path` are
transport/session results, not persisted domain fields.

`AppMetadata.appDataSchemaVersion` belongs to the versioned storage envelope
planned in U3/U4. The two legacy YAML schema versions belong only to the legacy
export anti-corruption boundary; they do not define domain state.

## Immutable confirmation context

Both `TaskSopRevision` and `RequirementRevision` contain a
`FrozenDependencyContext`. Confirmation copies the exact Customer, Material,
Scene, GlobalField, MaterialStateRule, and Attachment metadata required to
interpret/export that revision into this context. Pinned TaskSop and RobotModel
revision names stay in the root spec. Export must never refresh mutable values
from current catalogs.

## Explicitly non-domain UI state

The following `App.tsx` state is intentionally not represented in Proto:
selected navigation page and row, search/filter text, open modal/drawer state,
bulk-step textarea drafts before save, temporary table rows, upload progress,
toast/error strings, PDF print composition objects, and Requirement ↔ TaskSop
return-navigation state. These values are transient and are not written by any
`AppStore` method.

There are no unclassified persisted fields in the sources listed at the top of
this document. The converter fails its reconciliation gate if a later persisted
field is added without updating this ledger and Proto.
