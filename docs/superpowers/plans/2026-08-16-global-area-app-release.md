# Global Area Map Application and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate only globally audited administrative packages into the visit map, migrate existing users without data loss, and deploy the replacement atomically after two browser E2E rounds and a production audit.

**Architecture:** Runtime types and storage move from provisional country/source IDs to Overture `divisionId` identities while retaining immutable visit snapshots. The world→country→area UI loads only a release-ready same-origin manifest; country clicks navigate, area clicks immediately persist coral visits and open the editor. Versioned static directories and an atomic switch preserve rollback.

**Tech Stack:** TypeScript 6, SVG, Vite 8, IndexedDB, Vitest 4, Testing Library, Playwright 1.62, Nginx static hosting.

## Global Constraints

- Requires the complete verified output and independent review from `2026-08-16-global-country-audit.md`.
- The initial production candidate consumes only audited release `2026-06-17.0`; a later quarterly update is a separate atomic release.
- Production remains unchanged until the exact audited release passes every task in this plan.
- A country click never creates a visit; an unvisited area click immediately creates one and opens the editor.
- Dates remain optional year/month/day precision; notes remain plain text and at most 500 Unicode code points.
- Country packages load on demand from same-origin and remain last-known-good on invalid refresh.
- No production or test action touches `127.0.0.1:8080`; previews use another verified-free port.
- Deployment is atomic and keeps the previous static release recoverable.
- Every task follows RED → GREEN → self-review → focused verification → commit.

---

### Task 1: Runtime release and identity contracts

**Files:**
- Modify: `src/areas/types.ts`
- Modify: `src/areas/package-validator.ts`
- Modify: `src/areas/package-validator.test.ts`
- Modify: `src/domain/types.ts`
- Create: `src/areas/release-manifest.ts`
- Create: `src/areas/release-manifest.test.ts`

**Interfaces:**
- Produces `AreaId = divisionId`, `sourceCountryCode`, `sovereignCode`, `auditRelease`, and `parseReleaseReadyManifest(bytes)`.
- Manifest parsing succeeds only when `releaseReady === true`, every entry is `verified`, and `summaryChecksum` matches the approved review.

- [ ] **Step 1: Write failing tests** for provisional colon IDs, mixed audit releases, independent HK/MO/TW world entries, draft entries, unknown keys, checksum mismatch, and a valid verified manifest.
- [ ] **Step 2: Run** `npm test -- src/areas/package-validator.test.ts src/areas/release-manifest.test.ts`; expect RED.
- [ ] **Step 3: Implement strict types and reconstruction.** Preserve Overture `divisionId` verbatim within bounded/control-free rules; store source and sovereign codes separately; freeze all parsed values.
- [ ] **Step 4: Update package parsing** to require country package release and audit-report checksum equality with its manifest entry.
- [ ] **Step 5: Run** focused tests, `npm run typecheck`, and `npm run lint`.
- [ ] **Step 6: Self-review** ID collision, stale manifests, source/sovereign confusion, prototype pollution, and accidental acceptance of fixture-only manifests; fix findings.
- [ ] **Step 7: Commit** `feat: consume only globally audited boundary releases`.

### Task 2: IndexedDB schema upgrade and no-loss migration

**Files:**
- Modify: `src/storage/trip-store.ts`
- Modify: `src/storage/memory-store.ts`
- Modify: `src/storage/trip-store.test.ts`
- Modify: `src/storage/migration-types.ts`
- Modify: `src/storage/migrate-v1.ts`
- Create: `src/storage/migrate-provisional-area-ids.ts`
- Create: `src/storage/migrate-provisional-area-ids.test.ts`

**Interfaces:**
- Produces schema v2 stores `areaVisits`, `countryPackages`, `legacyVisits`, `releaseMeta` and idempotent migrations from V1 point visits and provisional area IDs.
- One-to-many mappings yield `ambiguous`; they never auto-select a new area.

- [ ] **Step 1: Write failing fake-indexeddb tests** for v1 upgrade, provisional ID→divisionId, unchanged divisionId geometry refresh, split, merge, removed ID, interrupted transaction, blocked upgrade, retry idempotency, and memory-store parity.
- [ ] **Step 2: Run** `npm test -- src/storage/trip-store.test.ts src/storage/migrate-provisional-area-ids.test.ts`; expect RED.
- [ ] **Step 3: Upgrade once in `onupgradeneeded`** without deleting V1 stores. Keep old snapshots until migration completion is durably recorded in `releaseMeta`.
- [ ] **Step 4: Apply `division-id-migrations.json` transactionally.** One-to-one moves identity; many-to-one merges metadata deterministically while retaining all notes; one-to-many/removal creates a visible unresolved record.
- [ ] **Step 5: Implement package cache replacement** keyed by sovereign country and audit release; invalid or quota-failed replacements leave the old entry intact.
- [ ] **Step 6: Prove the invariant** `resolved source IDs ∪ unresolved source IDs = all pre-upgrade source IDs` after export and re-import.
- [ ] **Step 7: Run** `npm test -- src/storage && npm run typecheck && npm run lint && git diff --check`.
- [ ] **Step 8: Self-review** transaction lifetime, concurrent tabs, note overflow, rollback, stale package cache, and silent deletion; fix findings.
- [ ] **Step 9: Commit** `feat: migrate visits to audited division identities`.

### Task 3: Global index and audited package loading

**Files:**
- Modify: `src/areas/area-index.ts`
- Modify: `src/areas/area-index.test.ts`
- Modify: `src/areas/country-package-service.ts`
- Modify: `src/areas/country-package-service.test.ts`
- Modify: `src/app-wiring.ts`
- Generate: `src/generated/area-index.data.ts`

**Interfaces:**
- Search returns exact `divisionId`, sovereign country, source country, Chinese-first display name, local name, and audit release.
- Package service rejects package/index release mismatch before persistence or rendering.

- [ ] **Step 1: Write failing tests** for Chinese-first display, local-name fallback, same-name disambiguation, CN/HK/MO/TW unified navigation, overseas territory sovereign navigation, stale index/package mismatch, offline cached success, and offline uncached failure.
- [ ] **Step 2: Run** `npm test -- src/areas/area-index.test.ts src/areas/country-package-service.test.ts`; expect RED.
- [ ] **Step 3: Generate the geometry-free global index** from the exact audited packages and prove set equality of all area IDs; reject any extra or missing ID.
- [ ] **Step 4: Require release-ready manifest first** in the package service; preserve 1 MiB manifest and package byte streaming limits, SHA-256 checks, cancellation isolation, and last-known-good cache semantics.
- [ ] **Step 5: Run** focused tests, compare two generated index files byte-for-byte, and execute `npm run typecheck && npm run lint`.
- [ ] **Step 6: Self-review** memory use, alias truncation, country ownership, stale search results, cross-country request races, and offline messaging; fix findings.
- [ ] **Step 7: Commit** `feat: search and load globally audited areas`.

### Task 4: World→country→area UI integration

**Files:**
- Modify: `src/navigation/map-view-model.ts`
- Modify: `src/map/map-engine.ts`
- Modify: `src/map/map-engine.test.ts`
- Modify: `src/ui/app.ts`
- Modify: `src/ui/app.test.ts`
- Modify: `src/styles.css`
- Modify: `src/app-wiring.test.ts`

**Interfaces:**
- World click invokes `enterCountry`; area click invokes `visitAreaThenEdit(divisionId)`.
- UI states are `world`, `country-loading`, `country-ready`, `country-stale`, and `country-unavailable` with explicit retry.

- [ ] **Step 1: Write failing UI tests** for every sovereign country path being clickable, CN consolidated entry, loading, verified render, stale warning, retry, immediate coral fill, editor focus, visited re-click, explicit remove/undo, fuzzy date/note save, breadcrumb, keyboard, reduced motion, and 360px drawer behavior.
- [ ] **Step 2: Run** `npm test -- src/ui/app.test.ts src/map/map-engine.test.ts src/app-wiring.test.ts`; expect RED.
- [ ] **Step 3: Integrate verified manifest navigation.** World country paths receive visited-area summaries but never represent country visits.
- [ ] **Step 4: Implement immediate visit then editor.** Persist before coral rendering; on storage failure restore the unvisited state and show export/storage recovery guidance.
- [ ] **Step 5: Render every audited area boundary** with event delegation, accessible names, keyboard activation, tiny-area hit targets, focused label only, and no city light-point fallback.
- [ ] **Step 6: Keep desktop side journal collapsible and mobile bottom drawer non-blocking** with focus moved to the editor heading and returned to the selected area on close.
- [ ] **Step 7: Run** `npm test -- src/ui src/map src/navigation src/app-wiring.test.ts && npm run typecheck && npm run lint`.
- [ ] **Step 8: Self-review** rapid country switching, click-before-save, DOM/path count, XSS through names, drawer obstruction, deletion, and screen-reader announcements; fix findings.
- [ ] **Step 9: Commit** `feat: light audited city areas from country maps`.

### Task 5: V2 backup, statistics, and posters

**Files:**
- Modify: `src/storage/backup.ts`
- Modify: `src/storage/backup.test.ts`
- Create: `src/storage/backup-v2.ts`
- Modify: `src/storage/statistics.ts`
- Modify: `src/storage/statistics.test.ts`
- Modify: `src/export/poster.ts`
- Modify: `src/export/poster.test.ts`

**Interfaces:**
- Produces strict BackupV2 with `auditRelease`, visited geometries, optional full cached packages, and merge/replace preview.
- Posters support world/country scope in 1600×1000 and 1200×1200 PNG.

- [ ] **Step 1: Write failing tests** for V2 release metadata, full visited boundary backup, optional package backup, 10 MiB/250 MiB limits, corrupt checksum, merge/replace rollback, sovereign country count, physical continent count, CN consolidation, country poster, no-note leakage, and PNG URL cleanup.
- [ ] **Step 2: Run** `npm test -- src/storage/backup.test.ts src/storage/statistics.test.ts src/export/poster.test.ts`; expect RED.
- [ ] **Step 3: Implement whitelist parsing and atomic import.** Unknown releases/packages enter preview as incompatible; user data remains recoverable and is never discarded during validation.
- [ ] **Step 4: Calculate statistics** from sovereign ownership plus physical area continent, not display labels or source country counts.
- [ ] **Step 5: Render posters** from validated snapshots only, with coral visited boundaries, audited attribution, custom/default title, and no notes/editor controls.
- [ ] **Step 6: Run** `npm test -- src/storage src/export && npm run typecheck && npm run lint && git diff --check`.
- [ ] **Step 7: Self-review** privacy leakage, JSON amplification, cross-release import, canvas taint, mobile memory, and URL cleanup; fix findings.
- [ ] **Step 8: Commit** `feat: export audited area backups and posters`.

### Task 6: Two-round browser E2E and visual review

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/global-area-main.spec.ts`
- Create: `tests/e2e/global-area-resilience.spec.ts`
- Modify: `scripts/inline-build.mjs`
- Modify: `scripts/inline-build.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces deterministic desktop/mobile browser evidence against the exact audited package set on a free port other than 8080.

- [ ] **Step 1: Write build tests** proving shell JS/CSS/index inline correctly, country packages remain same-origin external assets, release-ready manifest is copied, and no localhost/development URL enters output.
- [ ] **Step 2: Write desktop E2E** covering world→China, another region, immediate area visit/editor, fuzzy date/note, re-click, removal/undo, reload persistence, search deep link, both poster scopes, V2 export, merge and replace.
- [ ] **Step 3: Write 360px resilience E2E** covering drawer collapse, rapid country cancellation, offline cached/uncached, 404, 429, timeout, checksum mismatch, malformed package, quota failure, keyboard selection, reduced motion, ambiguous migration, and import rollback.
- [ ] **Step 4: Start preview only after checking the chosen port is free**; never use 8080. Run desktop round, add a focused failing regression for each defect, fix, and rerun the entire round.
- [ ] **Step 5: Use a fresh browser profile for mobile/resilience round**, deterministic network mocks, and the same defect-closure discipline; rerun both rounds after the final fix.
- [ ] **Step 6: Perform visual review** of world hierarchy, country fit, boundary density, coral contrast, tiny areas, Chinese/local labels, focus ring, loading/errors, and mobile obstruction.
- [ ] **Step 7: Run** `npm ci && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e && git diff --check`.
- [ ] **Step 8: Commit** `test: verify global audited area map end to end`.

### Task 7: Production audit, atomic deployment, and rollback

**Files:**
- Modify: `deploy/README.md`
- Modify: `deploy/nginx-location.conf`
- Modify: `README.md`
- Modify: `THIRD_PARTY_NOTICES.md`
- Create: `docs/releases/2026-06-17.0.md`
- Create: `.github/workflows/release.yml`
- Deliver after successful deployment: `outputs/travel-map.html`
- Deliver after successful deployment: `outputs/travel-map-preview.png`

**Interfaces:**
- Produces a versioned static release, exact deployed SHA/checksum evidence, a preserved previous release, and a tested atomic rollback command.

- [ ] **Step 1: Verify the independent global review** matches current commit, Overture release, summary checksum, manifest, packages, and index. Any mismatch stops deployment.
- [ ] **Step 2: Run the complete clean release gate** from Task 6 plus dependency audit, source/license audit, secret scan, CSP/static-header review, and package MIME/cache-policy checks.
- [ ] **Step 3: Commit and push** the normalized release commit; verify remote SHA and CI terminal success before touching the host release path.
- [ ] **Step 4: Copy artifacts into a new versioned static directory**, verify every file exists and is non-empty, recompute checksums there, and configure HTML no-cache plus immutable versioned data caching.
- [ ] **Step 5: Switch the application path atomically** to the new static directory without restarting or signaling `127.0.0.1:8080`; keep the prior directory and exact reversal command.
- [ ] **Step 6: Run hosted smoke checks** for world load, CN and two other region packages, checksum headers, area persistence/reload, mobile layout, search, backup, and PNG. A failure triggers immediate atomic rollback and a failed-release report.
- [ ] **Step 7: Perform rollback drill**, restore the new release, rerun smoke checks, and record timestamps, HTTP statuses, deployed commit, audit release, and checksums.
- [ ] **Step 8: Copy only the final standalone HTML shell and approved preview PNG** to session `outputs/`; check exit status and verify both are non-empty before linking them.
- [ ] **Step 9: Commit** `release: deploy globally audited area map` if release evidence changed after the release commit.
