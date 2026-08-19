LOAD spatial;
SET VARIABLE source_country_codes = __SOURCE_COUNTRY_CODES__;
CREATE TEMP TABLE reviewed_overrides(divisionId VARCHAR, divisionAreaId VARCHAR);
__OVERRIDE_INSERT__

SELECT CASE
  WHEN (SELECT count(*) FROM reviewed_overrides) = __OVERRIDE_COUNT__
    AND (
      SELECT count(*)
      FROM read_parquet('__UNRESOLVED_PATH__') AS area
      INNER JOIN reviewed_overrides AS reviewed
        ON area.divisionId = reviewed.divisionId AND area.divisionAreaId = reviewed.divisionAreaId
    ) = __OVERRIDE_COUNT__
  THEN true
  ELSE error('reviewed unresolved override mismatch')
END;

COPY (
  SELECT * FROM (
    SELECT
      area.divisionId,
      area.divisionAreaId,
      area.sourceCountryCode,
      division.names,
      division.subtype,
      division.adminLevel,
      map_extract_value(division.localType, 'en') AS localType,
      true AS isLand,
      division.hierarchies,
      division.perspectives,
      area.geometry
    FROM read_parquet('__SNAPSHOT_DATA_GLOB__', hive_partitioning = true) AS area
    INNER JOIN read_parquet('__DIVISION_METADATA_PATH__') AS division
      ON area.divisionId = division.divisionId
    WHERE list_contains(getvariable('source_country_codes'), area.sourceCountryCode)

    UNION ALL

    SELECT
      area.divisionId,
      area.divisionAreaId,
      __OVERRIDE_COUNTRY__ AS sourceCountryCode,
      division.names,
      division.subtype,
      division.adminLevel,
      map_extract_value(division.localType, 'en') AS localType,
      true AS isLand,
      division.hierarchies,
      division.perspectives,
      area.geometry
    FROM read_parquet('__UNRESOLVED_PATH__') AS area
    INNER JOIN reviewed_overrides AS reviewed
      ON area.divisionId = reviewed.divisionId AND area.divisionAreaId = reviewed.divisionAreaId
    INNER JOIN read_parquet('__DIVISION_METADATA_PATH__') AS division
      ON area.divisionId = division.divisionId
  )
  ORDER BY divisionId
) TO '__OUTPUT_PATH__' WITH (FORMAT GDAL, DRIVER 'GeoJSONSeq');
