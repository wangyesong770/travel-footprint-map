INSTALL httpfs;
LOAD httpfs;
INSTALL spatial;
LOAD spatial;
SET s3_region = 'us-west-2';
SET memory_limit = '2GB';
SET threads = 1;
SET temp_directory = '__TEMP_DIRECTORY__';
SET preserve_insertion_order = false;
SET partitioned_write_max_open_files = 8;
SET partitioned_write_flush_threshold = 65536;

COPY (
  SELECT
    id AS divisionId,
    country AS sourceCountryCode,
    names,
    subtype,
    admin_level AS adminLevel,
    local_type AS localType,
    hierarchies,
    perspectives
  FROM read_parquet('__DIVISION_URL__', hive_partitioning = false)
) TO '__DIVISION_METADATA_DIRECTORY__'
WITH (FORMAT PARQUET, PARTITION_BY (sourceCountryCode), COMPRESSION ZSTD);

COPY (
  SELECT
    division_id AS divisionId,
    id AS divisionAreaId,
    country AS sourceCountryCode,
    geometry
  FROM read_parquet('__DIVISION_AREA_URL__', hive_partitioning = false)
  WHERE is_land = true
) TO '__SNAPSHOT_DATA_DIRECTORY__'
WITH (FORMAT PARQUET, PARTITION_BY (sourceCountryCode), COMPRESSION ZSTD);

COPY (
  SELECT sourceCountryCode, count(*)::BIGINT AS rowCount
  FROM read_parquet('__SNAPSHOT_DATA_DIRECTORY__/**/*.parquet', hive_partitioning = true)
  GROUP BY sourceCountryCode
  ORDER BY sourceCountryCode
) TO '__ROW_COUNTS_PATH__' WITH (FORMAT JSON, ARRAY true);
