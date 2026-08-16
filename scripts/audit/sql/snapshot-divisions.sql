INSTALL httpfs;
LOAD httpfs;
INSTALL spatial;
LOAD spatial;
SET s3_region = 'us-west-2';
SET memory_limit = '2GB';
SET threads = 2;
SET temp_directory = '__TEMP_DIRECTORY__';
SET preserve_insertion_order = false;

CREATE TEMP TABLE joined_divisions AS
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
WHERE division_area.is_land = true;

COPY joined_divisions
TO '__SNAPSHOT_DATA_DIRECTORY__'
WITH (FORMAT PARQUET, PARTITION_BY (sourceCountryCode), COMPRESSION ZSTD);

COPY (
  SELECT sourceCountryCode, count(*)::BIGINT AS rowCount
  FROM joined_divisions
  GROUP BY sourceCountryCode
  ORDER BY sourceCountryCode
) TO '__ROW_COUNTS_PATH__' WITH (FORMAT JSON, ARRAY true);
