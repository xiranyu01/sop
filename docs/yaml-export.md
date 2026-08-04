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

## Robot topic frequencies

Requirement exports encode each robot topic as a mapping whose value starts
with the inclusive frequency range in the canonical form `min-max Hz`:

```yaml
robot:
  topics:
    /camera: 10-30 Hz
    /imu: 100-100 Hz; reliable
```

The range comes from the pinned RobotModel revision's structured
`frequency_hz` field. Topic constraints follow the range, separated by `; `.
Historical free-form topic IDs ending in two integer bounds are normalized to
the same representation. Topic entries without a frequency retain their
descriptive text unchanged.

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
