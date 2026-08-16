# Global Boundary Audit Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic Overture extraction, per-country QA, evidence, and CI system that cannot publish an unaudited or mixed-release global boundary set.

**Architecture:** Version-controlled sovereign and selector registries drive a fixed-release DuckDB extractor. Pure validators compute geometry, identity, naming, overlap, size, and reference-count evidence before a release assembler signs one atomic manifest. Browser code consumes only the signed result and never infers an administrative level.

**Tech Stack:** Node.js ESM, TypeScript 6, Vitest 4, DuckDB CLI with `httpfs`/`spatial`, Overture GeoParquet, TopoJSON, SHA-256, JSON Schema.

## Global Constraints

- Design authority is `docs/superpowers/specs/2026-08-16-global-boundary-audit-design.md`.
- The first audited release is exactly `2026-06-17.0` with schema `v1.17.0`, the current release shown by Overture's official calendar on 2026-08-16.
- Because Overture retains public release data for at most 60 days, Task 2 must capture the required division source-object inventory and checksums before country auditing proceeds.
- Every production country uses one exact Overture release; no mixed-release manifest is valid.
- `division.id` is the visit identity source; `division_area.id` and display names never define identity.
- Unconfigured, `draft`, or `failed` countries do not generate production packages.
- China uses `china-official`; all other countries use an explicitly reviewed perspective.
- No task may bind, stop, restart, or inspect `127.0.0.1:8080`.
- Every task follows RED → GREEN → self-review → focused verification → commit.

---

### Task 1: Audited registry contracts and strict loading

**Files:**
- Create: `src/audit/types.ts`
- Create: `src/audit/registry.ts`
- Create: `src/audit/registry.test.ts`
- Create: `data-audit/sovereign-registry.json`
- Create: `data-audit/release.json`
- Create: `data-audit/schema/country-audit.schema.json`
- Modify: `src/areas/country-schemes.ts`
- Modify: `src/areas/country-schemes.test.ts`

**Interfaces:**
- Produces: `CountryAuditConfig`, `SovereignRegistryEntry`, `loadAuditRegistry(input)`, `requireVerifiedCountryConfig(code)`.
- Replaces `CountryScheme.status: 'fallback'` with explicit `draft|failed|verified`; a missing country throws `CountryAuditError('COUNTRY_UNCONFIGURED')`.

- [ ] **Step 1: Write failing tests** proving missing countries, duplicate source codes, duplicate sovereign codes, empty selectors, unknown keys, invalid perspective, and `draft` lookup are rejected; prove CN owns `CN/HK/MO/TW` and those three source codes have no independent world entry.

```ts
expect(() => requireVerifiedCountryConfig('ZZ')).toThrowError(/COUNTRY_UNCONFIGURED/);
expect(registry.bySourceCode.get('TW')?.sovereignCode).toBe('CN');
expect(registry.worldEntries.some((entry) => entry.sovereignCode === 'TW')).toBe(false);
```

- [ ] **Step 2: Run** `npm test -- src/audit/registry.test.ts src/areas/country-schemes.test.ts`; expect RED because `src/audit/registry.ts` does not exist and fallback still succeeds.
- [ ] **Step 3: Add `data-audit/release.json`** with exact values `{ "release": "2026-06-17.0", "schemaVersion": "v1.17.0", "verifiedOn": "2026-08-16" }`; reject code/config/report data carrying any other release.
- [ ] **Step 4: Implement strict whitelist reconstruction** for the JSON registry. Freeze returned objects and nested arrays; cap references and exception IDs; reject prototype keys, control characters, duplicate ownership, and non-HTTPS official references.
- [ ] **Step 5: Make `getCountryScheme` strict.** It may expose a verified config but must never invent an admin level for an unknown country.
- [ ] **Step 6: Run** `npm test -- src/audit/registry.test.ts src/areas/country-schemes.test.ts && npm run typecheck && npm run lint` and require GREEN.
- [ ] **Step 7: Self-review** source-code ownership, normalization, frozen nested values, error data leakage, and accidental fallback compatibility; fix findings.
- [ ] **Step 8: Commit** `feat: require audited country boundary schemes`.

### Task 2: Fixed-release Overture extractor

**Files:**
- Create: `scripts/audit/extract-overture.mjs`
- Create: `scripts/audit/extract-overture.test.mjs`
- Create: `scripts/audit/sql/extract-country.sql`
- Create: `scripts/audit/lib/process-runner.mjs`
- Create: `scripts/audit/snapshot-source-manifest.mjs`
- Create: `data-audit/source-snapshots/2026-06-17.0.json`
- Modify: `package.json`

**Interfaces:**
- Produces CLI `npm run audit:extract -- --release 2026-06-17.0 --country CN --output .audit-work/CN` and the same command for any registry country code.
- Output is newline-delimited GeoJSON with `divisionId`, `divisionAreaId`, `sourceCountryCode`, names, hierarchy fields, perspective fields, and land Polygon/MultiPolygon.

- [ ] **Step 1: Write failing process tests** using an injected DuckDB runner. Assert exact release URLs, bound ISO parameters, `division.id = division_area.division_id`, `is_land = true`, deterministic `ORDER BY division.id`, rejection of shell metacharacters, and no output consumption after nonzero exit.

```js
await assert.rejects(
  extractCountry({ release: '2026-08-01.0;rm', country: 'CN', outputDir }),
  /invalid Overture release/,
);
```

- [ ] **Step 2: Run** `npm test -- scripts/audit/extract-overture.test.mjs`; expect RED because the extractor is absent.
- [ ] **Step 3: Implement the runner** with `spawn('duckdb', args, { shell: false })`, bounded stderr, a temporary output followed by atomic rename, and deletion of partial output on any error.
- [ ] **Step 4: Implement SQL** loading `httpfs` and `spatial`, selecting fixed-release `division` and `division_area` GeoParquet, filtering registered source country codes and land geometry, then exporting ordered GeoJSONSeq.
- [ ] **Step 5: Add preflight behavior.** `command -v duckdb` must succeed and `duckdb -version` must be recorded; absence fails with an actionable message rather than switching data engines silently.
- [ ] **Step 6: Snapshot source evidence before auditing.** Enumerate every `division` and `division_area` object consumed from `2026-06-17.0`, record URL/key, byte size, ETag and SHA-256 in `data-audit/source-snapshots/2026-06-17.0.json`, and verify any retained local cache against it before use.
- [ ] **Step 7: Run fixture tests twice** and compare output with `cmp`; run `npm run lint && git diff --check`.
- [ ] **Step 8: Self-review** command injection, release drift, upstream retention, partial files, remote error handling, peak disk use, and nondeterministic row ordering; fix findings.
- [ ] **Step 9: Commit** `feat: extract fixed Overture division releases`.

### Task 3: Selector, normalization, and QA engine

**Files:**
- Create: `scripts/audit/apply-selector.mjs`
- Create: `scripts/audit/apply-selector.test.mjs`
- Create: `scripts/audit/qa-country.mjs`
- Create: `scripts/audit/qa-country.test.mjs`
- Modify: `scripts/lib/boundary-normalize.mjs`
- Modify: `scripts/build-country-boundaries.mjs`

**Interfaces:**
- Produces `selectCountryFeatures(rows, config)` and `auditCountry(features, config, reference)`.
- Returns `{ status:'verified', metrics, exceptions } | { status:'failed', failures, metrics }`; it never returns an implicit pass.

- [ ] **Step 1: Write failing selector tests** for subtype/admin-level/local-type conjunction, allowlist-after-selector, denylist-last, source-code merge, duplicate `divisionId`, non-land rejection, and deterministic stable ordering.
- [ ] **Step 2: Write failing QA tests** for invalid rings, NaN, ID/index mismatch, duplicate geometry, forbidden overlap, legal flyway exception, missing local name, count mismatch, 5 MiB p95 warning, and 20 MiB hard failure.
- [ ] **Step 3: Run** `npm test -- scripts/audit/apply-selector.test.mjs scripts/audit/qa-country.test.mjs`; expect RED from missing modules.
- [ ] **Step 4: Implement selection as pure predicates.** Product levels are assigned from config and are never compared directly to raw Overture values unless the config explicitly says so.
- [ ] **Step 5: Implement iterative QA.** Use bounding boxes before polygon intersection, integer-safe vertex counters, explicit exception IDs, and machine-readable failure codes such as `COUNT_MISMATCH`, `OVERLAP_UNEXPLAINED`, and `PACKAGE_TOO_LARGE`.
- [ ] **Step 6: Wire the existing TopoJSON builder** to consume selected records and preserve `divisionId` as `sourceId`; emit the same IDs into the area index.
- [ ] **Step 7: Run** `npm test -- scripts/audit scripts/build-country-boundaries.test.mjs src/areas/package-validator.test.ts && npm run typecheck && npm run lint`.
- [ ] **Step 8: Self-review** antimeridian behavior, O(n²) overlap work, exception overreach, integer overflow, and simplification changing identity; fix findings.
- [ ] **Step 9: Commit** `feat: audit selected country boundary packages`.

### Task 4: Evidence reports and checksum binding

**Files:**
- Create: `scripts/audit/write-report.mjs`
- Create: `scripts/audit/write-report.test.mjs`
- Create: `data-audit/migrations/division-id-migrations.json`
- Create: `data-audit/reports/.gitkeep`
- Modify: `scripts/build-country-boundaries.mjs`

**Interfaces:**
- Produces canonical `data-audit/reports/2026-06-17.0/CN.json`-shaped country reports and `data-audit/reports/2026-06-17.0/summary.json`.
- `report.packageChecksum`, `manifest.checksum`, and the SHA-256 of final package bytes must be identical.

- [ ] **Step 1: Write failing tests** for canonical key order, stable output across two runs, checksum mismatch, stale selector version, missing reference date/license, secret-looking keys, absolute host paths, and report reuse against changed bytes.
- [ ] **Step 2: Run** `npm test -- scripts/audit/write-report.test.mjs`; expect RED because the writer is absent.
- [ ] **Step 3: Implement a whitelist report serializer** with source counts, selected/excluded counts, geometry metrics, p50/p95/max vertices, compressed bytes, performance timings, exceptions, source release, generator commit, and final checksum.
- [ ] **Step 4: Bind reports during assembly.** Read final bytes back from disk, verify non-empty, recompute SHA-256 and size, and only then atomically write report and manifest entries.
- [ ] **Step 5: Run deterministic report generation twice** into temporary directories and compare with `cmp`; then run focused tests and `git diff --check`.
- [ ] **Step 6: Self-review** stale evidence, filesystem path leakage, token leakage, timestamp nondeterminism, and report/package split-brain; fix findings.
- [ ] **Step 7: Commit** `feat: bind country audit evidence to package bytes`.

### Task 5: Atomic global release gate

**Files:**
- Create: `scripts/audit/verify-global-release.mjs`
- Create: `scripts/audit/verify-global-release.test.mjs`
- Create: `.github/workflows/global-boundary-audit.yml`
- Modify: `package.json`
- Create: `docs/data-sources.md`

**Interfaces:**
- Produces `npm run audit:global -- --release 2026-06-17.0 --packages public/data/countries --reports data-audit/reports/2026-06-17.0`.
- Success writes one `release-ready.json`; failure writes no production manifest and exits nonzero with sorted country/failure codes.

- [ ] **Step 1: Write failing global-gate tests** for one missing country, one draft country, mixed releases, missing report, mismatched checksum, missing attribution, China ownership mismatch, extra unregistered package, and fully verified fixture success.
- [ ] **Step 2: Run** `npm test -- scripts/audit/verify-global-release.test.mjs`; expect RED because the verifier is absent.
- [ ] **Step 3: Implement all-or-nothing verification.** Compare the registry’s complete world-entry set with packages and reports using exact set equality; verify every package again with the runtime validator contract.
- [ ] **Step 4: Add CI stages** `extract-fixture → country-qa → evidence → global-gate → build`. The production manifest upload runs only after global-gate success; CI retains failed reports as non-production diagnostics.
- [ ] **Step 5: Document source and license obligations** including ODbL, release URL, retrieval date, processing algorithm, public derivative availability, and attribution strings.
- [ ] **Step 6: Run** `npm ci && npm run lint && npm run typecheck && npm test && npm run build && git diff --check`; require all commands to pass.
- [ ] **Step 7: Self-review** partial artifact upload, stale CI cache, country-set equality, rollback artifact retention, and branch protection assumptions; fix findings.
- [ ] **Step 8: Commit** `ci: block release until global boundary audit passes`.

### Task 6: Quarterly release comparison and migration gate

**Files:**
- Create: `scripts/audit/compare-releases.mjs`
- Create: `scripts/audit/compare-releases.test.mjs`
- Create: `.github/ISSUE_TEMPLATE/quarterly-boundary-review.yml`
- Modify: `data-audit/migrations/division-id-migrations.json`
- Modify: `docs/data-sources.md`

**Interfaces:**
- Produces `npm run audit:compare -- --from 2026-06-17.0 --to "$CANDIDATE_RELEASE"` and a machine-readable change report.
- Result states are `no-review-required`, `manual-review-required`, and `blocked`; comparison never publishes artifacts.

- [ ] **Step 1: Write failing tests** for unchanged IDs with geometry drift, country count change of exactly 2%, count change above 2%, deleted ID, one-to-one replacement, one-to-many split, many-to-one merge, selector-result change, perspective change, and mixed/incomplete source manifests.
- [ ] **Step 2: Run** `npm test -- scripts/audit/compare-releases.test.mjs`; expect RED because the comparator is absent.
- [ ] **Step 3: Implement streaming comparison** by sovereign country and stable `divisionId`; geometry-only changes retain identity, while any deletion/split/merge, selector difference, political-view difference, or count delta above 2% returns `manual-review-required`.
- [ ] **Step 4: Validate migrations.** One-to-one and many-to-one entries must reference IDs present in the candidate package; one-to-many entries must be marked user-confirmation-required and may not supply an automatic chosen target.
- [ ] **Step 5: Add the quarterly issue template** with candidate release, schema version, source snapshot checksum, changed countries, migration counts, license changes, reviewer, and explicit global-gate rerun checklist.
- [ ] **Step 6: Run** focused tests plus `npm run lint && npm run typecheck && git diff --check`; verify the comparator writes no package or production manifest.
- [ ] **Step 7: Self-review** threshold boundary, schema breaks, removed upstream release access, change-report determinism, and accidental auto-publish behavior; fix findings.
- [ ] **Step 8: Commit** `feat: gate quarterly boundary release updates`.
