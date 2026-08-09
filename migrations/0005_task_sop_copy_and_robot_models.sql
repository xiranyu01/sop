-- Management-only metadata for task SOP copies and model filtering.
-- The canonical task ProtoJSON remains the source of truth; these projections
-- keep list/filter operations independent from full task payloads.
CREATE TABLE IF NOT EXISTS SOP_TASK_SOP_COPY_COUNTERS (
  series_id TEXT PRIMARY KEY,
  base_name TEXT NOT NULL,
  next_sequence INTEGER NOT NULL CHECK (next_sequence > 0),
  updated_at TEXT NOT NULL,
  CHECK (length(trim(series_id)) > 0),
  CHECK (length(trim(base_name)) > 0)
);

CREATE TABLE IF NOT EXISTS SOP_TASK_SOP_ROBOT_MODELS (
  task_sop_name TEXT NOT NULL,
  robot_model_name TEXT NOT NULL,
  PRIMARY KEY (task_sop_name, robot_model_name),
  FOREIGN KEY (task_sop_name) REFERENCES SOP_CURRENT_RESOURCES(name)
    ON UPDATE RESTRICT ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS SOP_TASK_SOP_ROBOT_MODELS_ROBOT
  ON SOP_TASK_SOP_ROBOT_MODELS(robot_model_name, task_sop_name);

ALTER TABLE SOP_CURRENT_RESOURCES ADD COLUMN task_robot_models_json TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS SOP_CURRENT_TASK_ROBOT_MODELS
  ON SOP_CURRENT_RESOURCES(task_robot_models_json)
  WHERE kind = 'TASK_SOP' AND archived_at IS NULL;

UPDATE SOP_CURRENT_RESOURCES
SET task_robot_models_json = COALESCE(json_extract(proto_json, '$.robotModels'), '[]')
WHERE kind = 'TASK_SOP' AND json_valid(proto_json);

INSERT OR IGNORE INTO SOP_TASK_SOP_ROBOT_MODELS (task_sop_name, robot_model_name)
SELECT current.name, models.value
FROM SOP_CURRENT_RESOURCES AS current
JOIN json_each(current.task_robot_models_json) AS models
WHERE current.kind = 'TASK_SOP';
