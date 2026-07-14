# YAML Export v1

## Contract

YAML export is an external, confirmed-only projection of the canonical Proto revision graph. The internal Proto model remains authoritative; YAML is not an independent domain model and is not read by the application in v1.

Every document starts with:

```yaml
format: coscene.sop.export
schema_version: 1.0.0
root:
  kind: requirement # or task_sop
  ref: requirement-...
```

The normative schema is `coscene.sop.export.v1alpha1.ExportBundle` in `proto/coscene/sop/export/v1alpha1/bundle.proto`. Field names in YAML use `lower_snake_case`. `schema_version` versions the YAML contract independently from the internal Proto package version.

## Identity and references

Each addressable entry has two separate identities:

- `ref` is a deterministic bundle-local reference used by all `*_ref` fields. Consumers must resolve it inside the same document and must not treat its hash algorithm as a business identifier.
- `source.resource_name` and `source.uid` are the canonical resource identity used for traceability and cross-system lookup. `source.source_id`, when present, preserves the originating system identifier.

Revision entries additionally include `revision.revision_name` and `revision.version_label`; `source_version_id` is included when the source supplied one. The bundle does not include revision history, `previous_revision`, `current_revision`, or mutable `etag`/timestamp metadata.

## Root closures

A Requirement export contains exactly the selected confirmed Requirement revision and its immutable closure:

- the frozen Customer and Requirement attachments;
- the exact pinned RobotModelRevision;
- each exact pinned, confirmed TaskSopRevision, deduplicated as a resource while preserving production-item order;
- each TaskSop revision's frozen Scene, Materials, vocabulary, material-state rules, and attachments.

A standalone TaskSop export contains only that confirmed TaskSop revision and its frozen closure. It does not infer a Requirement, Customer, or RobotModel.

Mutable current catalog values are never consulted for descriptive export content. Missing, ambiguous, draft, conflicting, or incomplete frozen dependencies make export fail closed.

## Attachments

An attachment entry contains only:

```yaml
- ref: attachment-...
  source:
    resource_name: attachments/...
    uid: ...
    source_id: ...
  filename: example.png
  media_type: image/png
  size_bytes: "1234"
  public_uri: https://cdn.example.com/path/example.png
  sha256: ... # optional
```

`public_uri` must already be an absolute HTTPS URI in the frozen revision. Export never fetches the URI, performs DNS resolution, or synthesizes it from `storage_key` or current deployment configuration. The original URI string is preserved byte-for-byte. Managed `storage_key` is internal and is never exported.

Legacy `reference_attachments` are descriptive file-token metadata rather than retrievable Attachment resources. They remain inside the TaskSop entry and are not converted into attachment refs or public URLs.

## Deterministic serialization

- Top-level and message fields follow the explicit Proto/YAML projection order.
- Resource collections are sorted by canonical resource or revision name before bundle construction.
- Semantic arrays retain their source order, including production items, objects, steps, policies, constraints, topics, languages, and reference paths.
- Enum values use stable lower-snake tokens such as `task_sop`, `p1`, `every_n_records`, and `not_required`.
- Dates use `YYYY-MM-DD`. Durations use canonical ISO 8601 values such as `PT1H`, `PT30M`, or `PT0.5S`. Proto `int64` values use lossless decimal strings.
- Optional absent fields are omitted; present empty strings remain empty strings. Repeated fields and implicit scalar values are emitted explicitly.
- Output uses UTF-8, LF line endings, no YAML aliases or custom tags, and exactly one trailing newline.

Repeated export of the same confirmed revision and frozen dependencies is byte-identical. Export has no generated timestamp.

## Evolution and future import

Import is intentionally not implemented in v1. The format avoids blocking it:

- references are bundle-local and independently resolvable;
- canonical names, UIDs, revision names, version labels, and source IDs retain provenance;
- all domain content is represented by typed export Proto messages rather than arbitrary YAML maps;
- internal storage locations, request-time URLs, and volatile metadata are excluded.

Compatible additions may add optional fields under `1.x`. Removing fields, changing meanings, changing reference rules, or changing scalar encoding requires a new major `schema_version`. Unknown major versions must be rejected by a future importer.
