# SOP YAML export contract

## Version boundaries

The downloadable domain YAML is selected by the exact pair
`format: coscene.sop.export` and `schema_version`. The current version is
`2.1.0`; consumers must reject unknown versions instead of guessing a nearby
adapter.

These version axes are independent:

- `schema_version` versions the external YAML shape.
- The SOP application/package version versions the deployed application.
- Proto package `coscene.sop.v1alpha1` versions the internal domain API.
- The sealed export bundle currently remains at schema `1.0.0`.
- Requirement and Task SOP revision labels and UIDs identify business
  revisions; they are not schema or application versions.

Changing one axis does not imply compatibility with or require a change to any
other axis.

## Document roots

Every document contains exactly one root:

```yaml
format: coscene.sop.export
schema_version: 2.1.0
requirement: {}
```

or:

```yaml
format: coscene.sop.export
schema_version: 2.1.0
task_sop: {}
```

A Requirement export contains the confirmed Requirement revision and the
confirmed Task SOP revisions selected by its production items. A standalone
Task SOP export has no Requirement context and therefore does not contain
delivery-language declarations.

## Delivery languages

Requirement exports preserve the legacy display-name list and add a
machine-readable list:

```yaml
delivery_requirements:
  languages:
    - 简体中文
  delivery_languages:
    - key: zh-CN
      name: 简体中文
```

- `delivery_languages[].key` is the stable machine identifier.
- `delivery_languages[].name` is the canonical display name and must not be
  used for business decisions.
- `languages` remains for older consumers. The two lists are independent;
  consumers must not relate entries by array index.
- Known canonical pairs are `zh-CN / 简体中文` and `en / 英文`.
- `source / 原始文本` is an accepted compatibility alias for `zh-CN`, not a
  separate language or delivery mode. New exports normalize it to
  `zh-CN / 简体中文`.
- Duplicate aliases are emitted once in `delivery_languages`, preserving the
  first source occurrence. The legacy `languages` list remains unchanged.
- Unknown existing codes and names are exported losslessly so consumers can
  warn or add support without the producer discarding data.

## Per-item robot and production flow

Each entry of `production_requirement_items` carries the robot model and the
production pipeline that apply to that collection task:

```yaml
production_requirement_items:
  - title: 基线任务 SOP
    description: ""
    target_duration_hours: 1
    target_collection_count: 2
    robot:
      id: 0614b3b9-ee56-5f99-8397-822cb4e79e20
      brand: coScene
      model: Baseline
      terminal: 夹爪
      topics:
        /camera: ""
    production_flow: collect/transform/qa1/annotate/qa2
    task_sop:
      title: 基线任务 SOP
```

- The item-level `robot:` block has the same shape as the requirement-level
  `robot:` block, which is **unchanged** and still emitted. The requirement-level
  block is the default; an item that does not pin its own robot renders the
  default, so the item block is always complete on its own and a consumer never
  has to implement the fallback.
- `production_flow` is **omitted entirely** when the stored revision predates the
  field, or when a writer explicitly stored the unset choice. It is never emitted
  as an empty string, and no value is invented for a legacy revision. A consumer
  must treat an absent key as "unknown", not as a default pipeline.
- Accepted `production_flow` values:
  - `collect/transform/qa1/auto-annotate/annotate/qa2`
  - `collect/transform/qa1/annotate/qa2`
  - `collect/qa1/annotate/qa2`
  - `collect/annotate/qa1`
  - `collect/transform/qa1`
  - `collect`
- **Convention bend, deliberate.** `docs/proto-v1alpha1.md` states that
  slash-delimited multi-values are not supported. `production_flow` does not
  violate that rule: the stored value is a single atomic
  `coscene.sop.v1alpha1.ProductionFlow` enum value, and only its *external code*
  spells the pipeline stages with slashes. It is one opaque identifier, not a
  list. Consumers must match the whole string and must not split it on `/` to
  derive stages, and producers must not compose a new code by concatenation.
- These keys are additive, so **no consumer-visible version changes**:
  `schema_version` stays `2.1.0` and there is no other version field in the
  rendered YAML. `requirementYamlSchemaVersion` in `data/metadata.json` did move
  (`requirement_yaml_v0.11` → `requirement_yaml_v0.12`), but that value is an
  internal bootstrap-fixture marker — it is never embedded in exported YAML and a
  consumer cannot observe it. Detect the new keys by presence, not by version.
- `production_flow` is **permanently absent** for requirements that were imported
  as already-CONFIRMED: they never traverse Confirm, so nothing ever asked their
  author to choose a pipeline and nothing ever will. Consumers must treat the key
  as optional forever — not as a field that "will be there once everyone
  re-confirms".

## Identity and references

Requirement and Task SOP version IDs identify immutable source revisions.
Production items resolve their Task SOP detail by revision ID, never by display
name or list position. Source resource names, UIDs, revision names, version
labels, and optional source IDs are provenance only and do not grant overwrite
authority in another system.

## Deterministic serialization

- Field names use `lower_snake_case`.
- Semantic arrays retain source order; structured delivery languages retain
  first-occurrence order after canonical-key deduplication.
- Optional absent fields are omitted where the domain projection allows it;
  required repeated fields are emitted as arrays.
- Output is UTF-8 with LF line endings, no YAML aliases or custom tags, and
  exactly one trailing newline.
- Export contains no generated timestamp. Re-exporting the same confirmed
  revision and frozen dependency closure is byte-identical.

The generated Proto graph remains the internal source of truth. YAML is an
external projection and is not read back into the SOP application.
