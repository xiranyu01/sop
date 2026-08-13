-- Idempotency receipts for durable TaskSop draft saves. The canonical business
-- resource remains SOP_CURRENT_RESOURCES.proto_json; this table only records
-- transport-level outcomes so an unknown network result can be replayed.
CREATE TABLE IF NOT EXISTS SOP_RESOURCE_MUTATION_RECEIPTS (
  mutation_id TEXT PRIMARY KEY,
  resource_name TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  expected_etag TEXT NOT NULL,
  result_etag TEXT NOT NULL,
  result_json TEXT NOT NULL,
  editor_session_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (length(trim(mutation_id)) > 0),
  CHECK (length(trim(resource_name)) > 0),
  CHECK (length(trim(request_digest)) > 0)
);

CREATE INDEX IF NOT EXISTS SOP_RESOURCE_MUTATION_RECEIPTS_CREATED
  ON SOP_RESOURCE_MUTATION_RECEIPTS(created_at);

CREATE INDEX IF NOT EXISTS SOP_RESOURCE_MUTATION_RECEIPTS_RESOURCE
  ON SOP_RESOURCE_MUTATION_RECEIPTS(resource_name, created_at);
