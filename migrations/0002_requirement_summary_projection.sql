ALTER TABLE SOP_CURRENT_RESOURCES ADD COLUMN project_display_name TEXT;
ALTER TABLE SOP_CURRENT_RESOURCES ADD COLUMN deadline TEXT;
ALTER TABLE SOP_CURRENT_RESOURCES ADD COLUMN production_item_count INTEGER
  CHECK (production_item_count IS NULL OR production_item_count >= 0);
ALTER TABLE SOP_CURRENT_RESOURCES ADD COLUMN aggregate_duration TEXT;

UPDATE SOP_CURRENT_RESOURCES
SET project_display_name = NULLIF(COALESCE(
      json_extract(proto_json, '$.spec.projectDisplayName'),
      json_extract(proto_json, '$.spec.project_display_name')
    ), ''),
    deadline = CASE WHEN json_type(proto_json, '$.spec.deadline') = 'object'
      THEN printf('%04d-%02d-%02d',
        json_extract(proto_json, '$.spec.deadline.year'),
        json_extract(proto_json, '$.spec.deadline.month'),
        json_extract(proto_json, '$.spec.deadline.day'))
      ELSE NULL END,
    production_item_count = COALESCE(
      json_array_length(proto_json, '$.spec.productionItems'),
      json_array_length(proto_json, '$.spec.production_items'),
      0
    ),
    aggregate_duration = COALESCE(
      json_extract(proto_json, '$.spec.aggregateTarget.duration'),
      json_extract(proto_json, '$.spec.aggregate_target.duration')
    )
WHERE kind = 'REQUIREMENT';
