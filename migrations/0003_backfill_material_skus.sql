WITH existing_max AS (
  SELECT COALESCE(MAX(CAST(SUBSTR(sku, 4) AS INTEGER)), 0) AS value
  FROM SOP_CATALOG_RESOURCES
  WHERE kind = 'MATERIAL'
    AND UPPER(SUBSTR(sku, 1, 3)) = 'SKU'
    AND SUBSTR(sku, 4) <> ''
    AND SUBSTR(sku, 4) NOT GLOB '*[^0-9]*'
),
missing_skus AS (
  SELECT resources.name,
    printf('SKU%03d', existing_max.value + ROW_NUMBER() OVER (
      ORDER BY resources.created_at ASC, resources.name ASC
    )) AS generated_sku
  FROM SOP_CATALOG_RESOURCES AS resources
  CROSS JOIN existing_max
  WHERE resources.kind = 'MATERIAL'
    AND COALESCE(TRIM(resources.sku), '') = ''
)
UPDATE SOP_CATALOG_RESOURCES
SET sku = missing_skus.generated_sku,
  proto_json = json_set(proto_json, '$.sku', missing_skus.generated_sku)
FROM missing_skus
WHERE SOP_CATALOG_RESOURCES.name = missing_skus.name;
