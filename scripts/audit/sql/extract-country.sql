LOAD spatial;
SET VARIABLE source_country_codes = __SOURCE_COUNTRY_CODES__;

COPY (
  SELECT
    area.divisionId,
    area.divisionAreaId,
    area.sourceCountryCode,
    division.names,
    division.subtype,
    division.adminLevel,
    division.localType,
    true AS isLand,
    division.hierarchies,
    division.perspectives,
    area.geometry
  FROM read_parquet('__SNAPSHOT_DATA_GLOB__', hive_partitioning = true) AS area
  INNER JOIN read_parquet('__DIVISION_METADATA_PATH__') AS division
    ON area.divisionId = division.divisionId
  WHERE list_contains(getvariable('source_country_codes'), area.sourceCountryCode)
  ORDER BY area.divisionId
) TO '__OUTPUT_PATH__' WITH (FORMAT GDAL, DRIVER 'GeoJSONSeq');
