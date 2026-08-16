# Country Boundary Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce validated, deterministic, per-country administrative boundary packages and a browser loader that caches them safely.

**Architecture:** A checked-in country-level registry defines the globally non-uniform administrative scheme. A Node build pipeline converts source GeoJSON into deterministic TopoJSON packages and a manifest; a browser service fetches same-origin packages, validates checksum and geometry, and atomically caches the last valid version.

**Tech Stack:** TypeScript 6, Node.js ESM, Vitest 4, GeoJSON/TopoJSON, Fetch, Web Crypto, IndexedDB.

## Global Constraints

- Source changes stay in `repos/travel-footprint-map` on the isolated feature branch.
- Never bind, restart, or inspect `127.0.0.1:8080`; development preview uses another free port.
- Country packages load from same-origin `/travel-footprint-map/data/countries/{ISO}.topojson`.
- Every package is untrusted input and must pass size, schema, country, checksum, geometry, and vertex limits before persistence or rendering.
- The application shell may remain a self-contained HTML, but country packages are external on-demand assets.
- Each task uses RED → GREEN → self-review → focused verification → commit.

---

### Task 1: Stable area and manifest contracts

**Files:**
- Create: `src/areas/types.ts`
- Create: `src/areas/country-schemes.ts`
- Create: `src/areas/country-schemes.test.ts`
- Modify: `src/domain/types.ts`

**Interfaces:**
- Produces: `AreaId`, `CityAreaProperties`, `CountryManifestEntry`, `CountryBoundaryPackage`, `CountryScheme`, `getCountryScheme(countryCode)`.
- `AreaId` format: ``${countryCode}:${source}:${sourceId}``, with uppercase two-letter country code.

- [ ] **Step 1: Write failing contract tests.** Assert `CN` resolves to prefecture-level, `JP` to municipalities, `US` to county/independent-city equivalents, lowercase codes normalize, and unknown codes return an explicit fallback scheme rather than an arbitrary admin number.

```ts
expect(getCountryScheme('cn')).toMatchObject({ countryCode: 'CN', labelZh: '地级行政区' });
expect(getCountryScheme('JP').acceptedLevels).toContain('municipality');
expect(getCountryScheme('ZZ').status).toBe('fallback');
```

- [ ] **Step 2: Run** `npm test -- src/areas/country-schemes.test.ts` and confirm RED because the modules do not exist.
- [ ] **Step 3: Implement focused types and an immutable scheme registry.** Reject invalid country codes; include `source`, `acceptedLevels`, `labelZh`, and `status: 'verified'|'fallback'`.
- [ ] **Step 4: Run** `npm test -- src/areas/country-schemes.test.ts && npm run typecheck` and confirm GREEN.
- [ ] **Step 5: Self-review** for inconsistent property names, implicit admin-level guesses, mutable registry exposure, and identifiers that change with display names; fix findings.
- [ ] **Step 6: Commit** `feat: define country area contracts`.

### Task 2: Deterministic country-package builder

**Files:**
- Create: `scripts/build-country-boundaries.mjs`
- Create: `scripts/lib/boundary-normalize.mjs`
- Create: `scripts/build-country-boundaries.test.mjs`
- Create: `scripts/fixtures/boundaries/CN.geojson`
- Create: `scripts/fixtures/boundaries/US.geojson`
- Generate: `public/data/countries/manifest.json`
- Generate: `public/data/countries/CN.topojson`
- Generate: `public/data/countries/US.topojson`

**Interfaces:**
- Consumes: scheme registry exported as JSON-compatible values.
- Produces CLI `node scripts/build-country-boundaries.mjs --input <dir> --output <dir>` and deterministic manifest/package files.

- [ ] **Step 1: Write failing Node tests** for stable `areaId`, duplicate source-ID rejection, wrong-country rejection, polygon winding normalization, property whitelist, deterministic feature ordering, identical SHA-256 across two builds, and HTML-significant text preservation as JSON data.

```js
assert.equal(firstManifest.CN.checksum, secondManifest.CN.checksum);
assert.deepEqual(Object.keys(feature.properties).sort(), [
  'adminLevel', 'aliases', 'areaId', 'centroid', 'countryCode', 'nameLocal', 'nameZh', 'sourceId'
]);
```

- [ ] **Step 2: Run** `node --test scripts/build-country-boundaries.test.mjs` and confirm RED because the builder is missing.
- [ ] **Step 3: Implement normalization.** Accept only Polygon/MultiPolygon, finite WGS84 coordinates, closed rings, bounded strings and aliases; compute centroid; assign IDs from country/source/source ID; sort features by `areaId`.
- [ ] **Step 4: Implement deterministic package output.** Emit canonical JSON bytes, byte size, SHA-256, feature count, scheme label, version and attribution. Use a fixed simplification tolerance passed by country config; never derive identity from simplified geometry.
- [ ] **Step 5: Run the fixture builder twice** into separate temporary directories, compare hashes and byte-for-byte outputs, then run `npm run lint` and `npm run typecheck`.
- [ ] **Step 6: Self-review** license attribution, topology loss, antimeridian handling, path traversal in country codes, decompression bombs, output reproducibility and peak memory; fix findings.
- [ ] **Step 7: Commit** `feat: build deterministic country boundary packages`.

### Task 3: Runtime package validation

**Files:**
- Create: `src/areas/package-validator.ts`
- Create: `src/areas/package-validator.test.ts`
- Modify: `src/map/geometry.ts`

**Interfaces:**
- Consumes: `CountryBoundaryPackage`, `validateGeometry`.
- Produces: `parseCountryManifest(input)`, `parseCountryPackage(input, expectedEntry)` returning reconstructed whitelisted objects.

- [ ] **Step 1: Write failing tests** covering wrong schema version, country mismatch, duplicate `areaId`, invalid prototype keys, NaN/infinite coordinates, unsupported geometry, unclosed rings, single-feature and total vertex overflow, byte-size mismatch, feature-count mismatch, and valid fixture acceptance.
- [ ] **Step 2: Run** `npm test -- src/areas/package-validator.test.ts` and confirm RED.
- [ ] **Step 3: Implement strict reconstruction.** Do not spread parsed input; read whitelisted scalar fields, normalize country codes, cap names at 160 code points, aliases at 20 entries, individual geometry at 100,000 vertices, package total at 1,000,000 vertices, and raw response at the manifest byte budget plus 1% framing allowance.
- [ ] **Step 4: Run focused tests and typecheck.** Include a test object with `__proto__`, `constructor`, and unknown nested properties and verify none survive.
- [ ] **Step 5: Self-review** integer overflow, nested-array recursion depth, error messages leaking raw data, and checksum-versus-parsed-byte ordering; fix findings.
- [ ] **Step 6: Commit** `feat: validate country boundary packages`.

### Task 4: Same-origin loader and cache state machine

**Files:**
- Create: `src/areas/country-package-service.ts`
- Create: `src/areas/country-package-service.test.ts`
- Create: `src/areas/country-package-repository.ts`
- Create: `src/areas/country-package-memory-repository.ts`

**Interfaces:**
- Produces: `CountryPackageRepository.get/put/delete/list`, an in-memory test adapter, and `CountryPackageService.load(countryCode, signal)` returning `fresh|cached|stale-cache|unavailable` with the package when available.
- Consumes: `parseCountryManifest`, `parseCountryPackage`, injectable `fetch`, `crypto.subtle`, clock and repository.

- [ ] **Step 1: Write failing service tests** for fresh cache, stale cache refresh, HTTP 404, HTTP 429, timeout/abort, fetch ignoring abort, invalid checksum, malformed package, failed atomic replacement, concurrent same-country request deduplication, and explicit manual retry.

```ts
await expect(service.load('CN', signal)).resolves.toMatchObject({ status: 'fresh' });
expect(fetchMock).toHaveBeenCalledWith('/travel-footprint-map/data/countries/CN.topojson', expect.objectContaining({ signal: expect.any(AbortSignal) }));
```

- [ ] **Step 2: Run** `npm test -- src/areas/country-package-service.test.ts` and confirm RED.
- [ ] **Step 3: Define the repository port and memory adapter.** Use `countryCode` as key, copy-then-swap for atomic replacement, and `structuredClone` on all reads and writes. The persistent IndexedDB adapter is added by the storage migration plan after the database version is upgraded once.
- [ ] **Step 4: Implement manifest-first loading and SHA-256 verification.** Enforce a 12-second timeout even when injected fetch ignores its signal by racing the request; deduplicate in-flight country requests; do not auto-retry.
- [ ] **Step 5: Implement fallback semantics.** Return stale valid cache on refresh failure, return unavailable with typed reason when no cache exists, and never replace valid cache with invalid bytes.
- [ ] **Step 6: Run verification.** Execute `npm test -- src/areas/country-package-service.test.ts && npm run typecheck && npm run lint && git diff --check`; all commands must pass.
- [ ] **Step 7: Self-review** same-origin URL construction, cache poisoning, aborted promise cleanup, quota failure, split-brain fallback, version comparison, and concurrent tab behavior; fix findings.
- [ ] **Step 8: Commit** `feat: load and cache country boundary packages`.

### Task 5: Data-pipeline release gate

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Create: `docs/data-sources.md`

**Interfaces:**
- Produces scripts `boundaries:fixture`, `boundaries:verify`, and CI evidence that checked-in packages match the manifest.

- [ ] **Step 1: Add a failing integrity test** that recomputes every checked-in package checksum, byte size, feature count, unique ID count and country match from `manifest.json`.
- [ ] **Step 2: Run** `npm test -- src/areas scripts/build-country-boundaries.test.mjs` and confirm the new gate fails until scripts and fixture outputs are wired.
- [ ] **Step 3: Add exact npm scripts and CI commands.** CI runs fixture generation into a temporary directory and compares deterministic output without mutating the working tree.
- [ ] **Step 4: Document the data contract.** In `docs/data-sources.md`, add tables headed `Source`, `License`, `Retrieved`, `Countries`, `Attribution`, and `Simplification`; every manifest source and every fallback scheme must have one row.
- [ ] **Step 5: Run** `npm run boundaries:verify`, focused tests, `npm run lint`, `npm run typecheck`, and `git diff --check`; all pass.
- [ ] **Step 6: Self-review** CI network independence, missing-country reporting, stale generated files and attribution visibility; fix findings.
- [ ] **Step 7: Commit** `test: gate country boundary data integrity`.
