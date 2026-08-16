# Area Storage and Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move visits from point-city identity to stable administrative-area identity without silent data loss, and provide validated V2 backups with optional cached country packages.

**Architecture:** IndexedDB schema v2 adds area visits, country packages and quarantined legacy records while retaining v1 stores during migration. Pure migration and backup functions are tested separately from transaction adapters; UI integration consumes explicit migration results instead of guessing success.

**Tech Stack:** TypeScript 6, Vitest 4, IndexedDB, fake-indexeddb, GeoJSON point-in-polygon.

## Global Constraints

- Requires the area contracts and package validator from `2026-08-16-country-boundary-data.md` Task 1 and Task 3.
- Existing v1 records and imported backups must never be silently deleted.
- Import and migration writes are atomic; failure leaves the previously committed dataset intact.
- Notes remain plain text and at most 500 Unicode code points; fuzzy dates remain year, month or day.
- Backup input is untrusted and limited before expensive geometry traversal.
- Each task uses RED → GREEN → self-review → focused verification → commit.

---

### Task 1: V2 visit and migration result contracts

**Files:**
- Modify: `src/domain/types.ts`
- Create: `src/storage/migration-types.ts`
- Create: `src/storage/migration-types.test.ts`

**Interfaces:**
- Produces: `VisitV2`, `LegacyVisit`, `MigrationCandidate`, `MigrationResult`, `BackupV2`.
- `VisitV2` key is `areaId`; `LegacyVisit` contains the original `VisitRecord` plus `status` and optional candidates.

- [ ] **Step 1: Write failing serialization tests** proving V2 visits contain no numeric `cityId`, dates retain precision, unresolved records retain the complete v1 snapshot, and area snapshots are immutable clones.
- [ ] **Step 2: Run** `npm test -- src/storage/migration-types.test.ts` and confirm RED.
- [ ] **Step 3: Define discriminated unions.** Use `status: 'resolved'|'ambiguous'|'outside'|'country-unavailable'` and exact candidate `areaId` values. Define `BackupV2.schemaVersion` as literal `2`.
- [ ] **Step 4: Run verification.** Execute `npm test -- src/storage/migration-types.test.ts && npm run typecheck`; both commands must pass.
- [ ] **Step 5: Self-review** optional-field ambiguity, mutable nested aliases/geometries and mismatched timestamp names; fix findings.
- [ ] **Step 6: Commit** `feat: define area visit migration contracts`.

### Task 2: Point-to-area migration engine

**Files:**
- Create: `src/storage/migrate-v1.ts`
- Create: `src/storage/migrate-v1.test.ts`
- Modify: `src/map/geometry.ts`
- Modify: `src/map/geometry.test.ts`

**Interfaces:**
- Consumes: `VisitRecord`, validated `CountryBoundaryPackage`.
- Produces: `migrateCountryVisits(legacyVisits, countryPackage)` and `mergeMappedVisits(mappedVisits)`.

- [ ] **Step 1: Write failing geometry tests** for point inside polygon, hole exclusion, multipolygon inclusion, boundary-edge deterministic inclusion, antimeridian polygon, malformed ring rejection and identical overlapping candidates.

```ts
expect(findContainingAreas([116.4074, 39.9042], packageCN).map(x => x.areaId)).toEqual(['CN:osm:beijing']);
```

- [ ] **Step 2: Write failing migration tests** for unique match, zero match, multiple match, unavailable country package, multiple old cities merging into one area, earliest non-empty visit date, newer metadata precedence, and all notes retained with source-city labels.
- [ ] **Step 3: Run** `npm test -- src/map/geometry.test.ts src/storage/migrate-v1.test.ts` and confirm RED.
- [ ] **Step 4: Implement an iterative point-in-polygon helper** with bounding-box prefilter and no recursive traversal. Return sorted candidate IDs for deterministic review.
- [ ] **Step 5: Implement pure migration.** A unique match produces `VisitV2`; ambiguous/outside/unavailable inputs remain complete `LegacyVisit` records. Merge notes without exceeding 500 code points by retaining overflow in the unresolved legacy record rather than truncating silently.
- [ ] **Step 6: Run verification.** Execute `npm test -- src/map/geometry.test.ts src/storage/migrate-v1.test.ts && npm run typecheck && npm run lint`; all commands must pass.
- [ ] **Step 7: Self-review** coordinate order, boundary edges, date conflict policy, note loss, duplicate IDs, O(n×m) behavior and antimeridian handling; fix findings.
- [ ] **Step 8: Commit** `feat: migrate point visits to administrative areas`.

### Task 3: IndexedDB v2 transactional repository

**Files:**
- Modify: `src/storage/trip-store.ts`
- Modify: `src/storage/memory-store.ts`
- Modify: `src/storage/trip-store.test.ts`
- Modify: `src/app-wiring.ts`

**Interfaces:**
- Implements the `CountryPackageRepository` port and produces repository methods `getAreaVisit`, `listAreaVisits`, `putAreaVisit`, `deleteAreaVisit`, `listLegacyVisits`, `resolveLegacyVisit`, `getCountryPackage`, `putCountryPackage`, `deleteCountryPackage`, `listCountryPackages`.
- Retains read-only v1 methods only for the migration boundary until release completion.

- [ ] **Step 1: Write failing fake-indexeddb tests** for v1→v2 open, v1 record preservation, new-store CRUD, area-ID uniqueness, atomic country migration, quota rejection, blocked upgrade, failed replace rollback and memory-adapter parity.
- [ ] **Step 2: Run** `npm test -- src/storage/trip-store.test.ts` and confirm RED.
- [ ] **Step 3: Increment database version to 2** and create `areaVisits`, `countryPackages`, and `legacyVisits`. Do not delete `visits` or `boundaries` in `onupgradeneeded`.
- [ ] **Step 4: Implement `migrateLegacyCountry(countryCode, package)`** as one readwrite transaction across old and new stores. Mark migrated source IDs in meta so reruns are idempotent.
- [ ] **Step 5: Implement memory parity** using copy-then-swap for atomic imports and `structuredClone` on all reads/writes.
- [ ] **Step 6: Run verification.** Execute `npm test -- src/storage && npm run typecheck && npm run lint`; all commands must pass.
- [ ] **Step 7: Self-review** upgrade blocking, transaction lifetime across awaited requests, crash recovery, idempotency, concurrent tabs and accidental v1 deletion; fix findings.
- [ ] **Step 8: Commit** `feat: persist area visits with safe v1 migration`.

### Task 4: Strict V2 backup import and export

**Files:**
- Modify: `src/storage/backup.ts`
- Modify: `src/storage/backup.test.ts`
- Create: `src/storage/backup-v2.ts`

**Interfaces:**
- Produces: `parseBackupV2(text)`, `exportBackupV2(snapshot, includeCountryPackages)`, `previewBackupV2(backup)`, `importBackupV2(backup, 'merge'|'replace')`.
- Accepts V1 through `parseBackup` and returns a typed `needs-migration` result rather than coercing it to V2.

- [ ] **Step 1: Write failing tests** for minimal V2 export, optional complete cached-country packages, embedded visited-area geometry, 10 MB normal backup limit, explicit 250 MB complete-backup limit, duplicate IDs, unknown schema, prototype keys, invalid dates, oversized notes, invalid checksums, merge newer-wins and replace rollback.
- [ ] **Step 2: Run** `npm test -- src/storage/backup.test.ts` and confirm RED.
- [ ] **Step 3: Implement strict parsing and preview.** Parse top-level byte length before JSON traversal; reconstruct whitelisted fields; validate package bytes/checksums; calculate record, country and byte counts without rendering untrusted text as HTML.
- [ ] **Step 4: Implement export.** Always include full geometry for visited areas; include complete cached country packages only when requested; ensure no object URLs or private note values are logged.
- [ ] **Step 5: Implement merge/replace transactions.** Merge by `areaId` and newest valid `updatedAt`; package merge uses manifest version/update timestamp; replace clears only V2 target stores after validation succeeds.
- [ ] **Step 6: Run verification.** Execute `npm test -- src/storage/backup.test.ts src/storage/trip-store.test.ts && npm run typecheck && npm run lint && git diff --check`; all commands must pass.
- [ ] **Step 7: Self-review** zip-bomb equivalents, JSON memory amplification, stale package conflict, partial replace, title conflict, corrupt V1 behavior and privacy leakage; fix findings.
- [ ] **Step 8: Commit** `feat: add complete v2 area backups`.

### Task 5: Statistics and migration acceptance gate

**Files:**
- Modify: `src/storage/statistics.ts`
- Modify: `src/storage/statistics.test.ts`
- Create: `src/storage/migration.integration.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces `calculateAreaStats(visits)` and evidence that a v1 database/backup reaches either resolved V2 or a visible unresolved queue with no missing source IDs.

- [ ] **Step 1: Write failing tests** for duplicate area IDs, multiple areas in one country, continent totals, unknown country metadata, and the invariant `resolved source IDs ∪ unresolved source IDs = all original source IDs`.
- [ ] **Step 2: Run** `npm test -- src/storage/statistics.test.ts src/storage/migration.integration.test.ts` and confirm RED.
- [ ] **Step 3: Implement area statistics** using a checked-in country-to-continent mapping, never the display label.
- [ ] **Step 4: Add an integration fixture** containing unique, ambiguous and outside old city points; open as DB v1, upgrade, load packages, migrate, export V2, replace-import into a fresh DB, and assert equality of resolved plus unresolved identities.
- [ ] **Step 5: Document migration and recovery.** Add README sections `旧数据迁移`, `完整备份体积`, and `待确认记录`; state that unresolved records are retained, complete backups may reach 250 MB, and users must load the relevant country package before resolving a legacy visit.
- [ ] **Step 6: Run verification.** Execute `npm test -- src/storage src/domain && npm run typecheck && npm run lint && git diff --check`; all commands must pass.
- [ ] **Step 7: Self-review** the no-loss invariant and user-visible recovery path; fix findings.
- [ ] **Step 8: Commit** `test: prove lossless area data migration`.
