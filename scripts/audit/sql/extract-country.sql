INSTALL httpfs;
LOAD httpfs;
INSTALL spatial;
LOAD spatial;
SET s3_region = 'us-west-2';
SET VARIABLE source_country_codes = __SOURCE_COUNTRY_CODES__;

COPY (
  SELECT
    division.id AS divisionId,
    division_area.id AS divisionAreaId,
    division.country AS sourceCountryCode,
    division.names AS names,
    division.subtype AS subtype,
    division.admin_level AS adminLevel,
    division.local_type AS localType,
    division.hierarchies AS hierarchies,
    division.perspectives AS perspectives,
    division_area.geometry AS geometry
  FROM read_parquet('__DIVISION_URL__', hive_partitioning = false) AS division
  INNER JOIN read_parquet('__DIVISION_AREA_URL__', hive_partitioning = false) AS division_area
    ON division.id = division_area.division_id
  WHERE list_contains(getvariable('source_country_codes'), division.country)
    AND division_area.is_land = true
  ORDER BY division.id
) TO '__OUTPUT_PATH__' WITH (FORMAT GDAL, DRIVER 'GeoJSONSeq');
