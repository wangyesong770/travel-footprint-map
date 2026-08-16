LOAD spatial;
SET VARIABLE source_country_codes = __SOURCE_COUNTRY_CODES__;

COPY (
  SELECT
    divisionId,
    divisionAreaId,
    sourceCountryCode,
    names,
    subtype,
    adminLevel,
    localType,
    hierarchies,
    perspectives,
    geometry
  FROM read_parquet('__SNAPSHOT_DATA_GLOB__', hive_partitioning = true)
  WHERE list_contains(getvariable('source_country_codes'), sourceCountryCode)
  ORDER BY divisionId
) TO '__OUTPUT_PATH__' WITH (FORMAT GDAL, DRIVER 'GeoJSONSeq');
