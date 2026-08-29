# ArtBox Provider Media Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-shaped, unbilled ArtBox video integration whose browser requests contain only stable Asset IDs and whose media bytes live in Tencent COS.

**Architecture:** Build the stable Asset/COS boundary first, then add a fixed server-side ArtBox adapter and Workspace-scoped generation record, and finally connect the existing Canvas Composer through provider-neutral bindings. The slice is explicitly isolated from the canonical billed AI Task workflow, so credits, ledger, billing, platform-admin purpose values, and the Worker remain unchanged.

**Tech Stack:** TypeScript, Fastify 5, TypeBox, PostgreSQL/Drizzle with RLS, `cos-nodejs-sdk-v5`, React/Zustand, Vitest, native `fetch`.

**Spec:** `docs/designs/2026-08-29-artbox-provider-media-input.md`

## Global Constraints

- Browser requests and cloud snapshots persist only `assetId`, never signed URLs, object keys, `storageKey`, `blob:` URLs, base64 media, Provider keys, or executable adapter configuration.
- ArtBox protocol details exist only in the server adapter.
- Provider and COS calls run outside database transactions.
- A result Asset is `ready` before a generation is `succeeded`.
- Ambiguous creation is never blindly resubmitted.
- All timeout, TTL, lease, and maximum-byte values are required deployment configuration with no code defaults.
- Do not modify credits, ledger, billing, `WORKSPACE_ADMIN_PURPOSES`, `server/src/worker.ts`, or another worktree.
- Add new migrations after `0007`; never edit a historical migration.

---

### Task 1: Stable Asset contracts and Tencent COS boundary

**Files:**
- Create: `packages/contracts/src/assets.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `server/src/infrastructure/object-storage/types.ts`
- Create: `server/src/infrastructure/object-storage/tencent-cos.ts`
- Create: `server/src/modules/assets/schema.ts`
- Create: `server/src/modules/assets/service.ts`
- Create: `server/src/modules/assets/routes.ts`
- Create: `server/migrations/0008_assets.sql`
- Modify: `server/src/config.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/infrastructure/database/schema.ts`
- Modify: `server/scripts/check-module-boundaries.ts`
- Modify: `server/package.json`
- Modify: `bun.lock`
- Test: `server/test/assets/contracts.test.ts`
- Test: `server/test/assets/service.test.ts`
- Test: `server/test/assets/routes.test.ts`
- Test: `server/test/config.test.ts`
- Test: `server/test/database/migration-upgrade.test.ts`

**Interfaces:**
- Consumes: existing `withTenantTransaction`, session/workspace authorization, `AppError`, and Fastify error envelope.
- Produces: `ObjectStorage` with `createUpload`, `completeUpload`, `createReadUrl`, `putResult`; Asset route contracts; `getReadyAssets(db, workspaceId, refs)` for Task 2.

- [ ] **Step 1: Write contract and configuration tests that fail**

Define closed TypeBox request/response schemas for create, complete, and read. Add tests proving `assetId` is a UUID, kinds are `image|video|audio`, response objects reject object keys, partial COS configuration fails, and configured numeric boundaries are positive integers.

- [ ] **Step 2: Run the focused red tests**

Run: `bun --cwd server run test -- test/assets/contracts.test.ts test/config.test.ts`

Expected: FAIL because Asset contracts and COS configuration do not exist.

- [ ] **Step 3: Implement the contracts and injectable storage interface**

Use these signatures:

```ts
export type StoredObject = { key: string; contentType: string; byteSize: number; etag?: string };
export interface ObjectStorage {
  createUpload(input: { stagingKey: string; contentType: string; expiresInSeconds: number }): Promise<{ url: string; headers: Record<string, string> }>;
  completeUpload(input: { stagingKey: string; finalKey: string; expectedContentType: string }): Promise<StoredObject>;
  createReadUrl(input: { key: string; expiresInSeconds: number }): Promise<string>;
  putResult(input: { key: string; contentType: string; bytes: Uint8Array }): Promise<StoredObject>;
}
```

`createTencentCosStorage` wraps the official SDK. Completion HEAD-checks the staging object, copies it to a separate final key, verifies the final key, and best-effort deletes only the staging key.

- [ ] **Step 4: Write failing Asset service, route, RLS, and upgrade tests**

Cover member create/complete/read, non-member denial, cross-tenant invisibility, state transitions, completion verification failure, duplicate complete idempotency, fresh display URL issuance, explicit grants, forced RLS, and upgrade from migration `0007`.

- [ ] **Step 5: Run the focused Asset tests and confirm failure**

Run: `bun --cwd server run test -- test/assets test/database/migration-upgrade.test.ts`

Expected: FAIL because the table, services, routes, and migration are absent.

- [ ] **Step 6: Implement the minimal Asset vertical slice**

Create server-generated staging and final keys from UUIDs, persist immutable final keys, and enforce `staging -> ready|failed -> deleted`. Run storage calls between short tenant transactions. Return upload URL only from create and display URL only from read; never return either object key. Register routes only when configuration and database are present.

- [ ] **Step 7: Run focused checks**

Run: `bun --cwd server run test -- test/assets test/config.test.ts test/database/migration-upgrade.test.ts`

Run: `bun --cwd server run typecheck`

Run: `bun --cwd server run check:boundaries`

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src server/src/infrastructure/object-storage server/src/modules/assets server/src/config.ts server/src/app.ts server/src/infrastructure/database server/scripts/check-module-boundaries.ts server/migrations server/test/assets server/test/config.test.ts server/test/database/migration-upgrade.test.ts server/package.json bun.lock
git commit -m "feat: add stable COS-backed assets"
```

### Task 2: Fixed ArtBox adapter and unbilled generation lifecycle

**Files:**
- Create: `packages/contracts/src/artbox.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `server/src/modules/artbox/schema.ts`
- Create: `server/src/modules/artbox/adapter.ts`
- Create: `server/src/modules/artbox/service.ts`
- Create: `server/src/modules/artbox/routes.ts`
- Create: `server/migrations/0009_artbox_video_generations.sql`
- Modify: `server/src/config.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/infrastructure/database/schema.ts`
- Modify: `server/scripts/check-module-boundaries.ts`
- Test: `server/test/artbox/contracts.test.ts`
- Test: `server/test/artbox/adapter.test.ts`
- Test: `server/test/artbox/service.test.ts`
- Test: `server/test/artbox/routes.test.ts`
- Test: `server/test/database/migration-upgrade.test.ts`

**Interfaces:**
- Consumes: Task 1 `ObjectStorage`, `getReadyAssets`, Asset schema, and `hashCanonicalRequest`.
- Produces: `createArtBoxVideoGeneration`, `pollArtBoxVideoGeneration`, and two same-origin Workspace routes used by Task 3.

- [ ] **Step 1: Write failing closed-contract tests**

Assert the public body accepts only `model`, `promptTemplate`, typed `bindings`, `seconds`, optional `aspectRatio/resolution`, and `generateAudio`; rejects `image_urls`, `video_urls`, `audio_urls`, `url`, `storageKey`, and extra fields; and requires `Idempotency-Key`.

- [ ] **Step 2: Write failing adapter protocol tests**

Use a fake fetch to assert exact `POST /v1/video/generations`, Bearer header, JSON content type, token rewriting to independent `@图片N/@视频N/@音频N` sequences, complete ordered URL arrays, omission of empty arrays, URL-encoded polling IDs, response-envelope parsing, unknown-state reconciliation, and sanitized 401/429/5xx/network failures.

- [ ] **Step 3: Run contract and adapter tests to verify red**

Run: `bun --cwd server run test -- test/artbox/contracts.test.ts test/artbox/adapter.test.ts`

Expected: FAIL because the contract and adapter are absent.

- [ ] **Step 4: Implement the pure fixed adapter**

Expose:

```ts
createArtBoxAdapter(config, fetchImpl): {
  create(input: ArtBoxCreateInput): Promise<ArtBoxCreateOutcome>;
  poll(remoteTaskId: string): Promise<ArtBoxPollOutcome>;
}
```

Use an `AbortController` with the configured timeout. Keep Authorization, signed URLs, and raw response bodies out of errors. Only configured models are accepted.

- [ ] **Step 5: Write failing lifecycle, idempotency, and tenancy tests**

Cover same key/same hash replay without a second Provider call, conflicting hash `409`, ready Asset validation, cross-tenant hiding, kind mismatch, create calls after transaction commit, remote ID persistence, ambiguous create to `reconciling`, terminal replay, poll-only behavior after remote ID, result HTTPS/host/size validation, result Asset ready-before-success, and no signed URL persistence.

- [ ] **Step 6: Run lifecycle tests to verify red**

Run: `bun --cwd server run test -- test/artbox/service.test.ts test/artbox/routes.test.ts test/database/migration-upgrade.test.ts`

Expected: FAIL because persistence and routes do not exist.

- [ ] **Step 7: Implement the local generation record and routes**

Persist only normalized input and Asset IDs. Create the local `submitting` row in one tenant transaction, call ArtBox after commit, then persist `remote_task_id` in a second transaction. Poll explicitly, normalize status, and on success download the allowlisted HTTPS result with configured timeout and byte cap, call `ObjectStorage.putResult`, create a `ready` video Asset, and only then mark the generation `succeeded`. Ambiguous creates remain `reconciling` and cannot be submitted again.

- [ ] **Step 8: Run focused checks**

Run: `bun --cwd server run test -- test/artbox test/assets test/config.test.ts test/database/migration-upgrade.test.ts`

Run: `bun --cwd server run typecheck`

Run: `bun --cwd server run check:boundaries`

Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src server/src/modules/artbox server/src/config.ts server/src/app.ts server/src/infrastructure/database server/scripts/check-module-boundaries.ts server/migrations server/test/artbox server/test/database/migration-upgrade.test.ts
git commit -m "feat: add server-side ArtBox video integration"
```

### Task 3: Canvas Asset hydration and hosted ArtBox generation

**Files:**
- Create: `web/src/services/api/assets.ts`
- Create: `web/src/services/api/artbox.ts`
- Create: `web/src/services/api/hosted-media.test.ts`
- Create: `web/src/services/hosted-media.ts`
- Modify: `web/src/types/canvas.ts`
- Modify: `web/src/types/media.ts`
- Modify: `web/src/components/canvas/canvas-node-generation.ts`
- Modify: `web/src/lib/canvas/canvas-generation-helpers.ts`
- Modify: `web/src/lib/canvas/canvas-snapshot.ts`
- Modify: `web/src/pages/canvas/project.tsx`
- Modify: `web/src/stores/use-config-store.ts`
- Test: `web/src/services/api/artbox.test.ts`
- Test: `web/src/services/canvas-recovery/draft-snapshot.test.ts`
- Test: `web/src/services/hosted-media.test.ts`

**Interfaces:**
- Consumes: Task 1 Asset routes and Task 2 ArtBox generation routes.
- Produces: `ensureAssetReady`, `buildHostedVideoRequest`, `requestHostedArtBoxVideo`, and Asset-backed Canvas node metadata.

- [ ] **Step 1: Write failing API serialization tests**

Assert same-origin `/api/v1` calls, credential inclusion through the existing request helper, required idempotency header, polling response parsing, and a deep scan proving request bodies contain no URL, `storageKey`, blob, data URL, object key, or API key.

- [ ] **Step 2: Write failing hosted-media tests**

Test that existing ready `assetId` values are reused, local image/video/audio blobs create-upload-complete exactly once, missing local bytes fail with a typed message, Composer token order produces typed bindings, and all three media kinds remain present without truncation.

- [ ] **Step 3: Run the focused web tests and confirm failure**

Run: `bun --cwd web run test -- src/services/api/artbox.test.ts src/services/hosted-media.test.ts`

Expected: FAIL because the hosted clients and helpers are absent.

- [ ] **Step 4: Implement focused API clients and media preparation**

Build on the existing same-origin request helper. `ensureAssetReady` reads `getImageBlob` or `getMediaBlob`, uploads the exact Blob with the server-returned headers, completes it, and returns only the Asset ID. `buildHostedVideoRequest` preserves `@[node:<id>]` in `promptTemplate` and emits ordered typed bindings.

- [ ] **Step 5: Write failing snapshot and Canvas branch tests**

Assert Asset-backed image/video/audio nodes serialize `assetId` but omit transient `url`, `content`, and `storageKey`; hydration requests a fresh display URL; hosted ArtBox selection bypasses browser key/base/plugin configuration; repeated terminal polls update one target node rather than inserting duplicates.

- [ ] **Step 6: Implement the minimal Canvas branch**

Add the explicit hosted model `Artdance 2 Mini-480p`, leave local/custom models unchanged, and branch only at the existing video-generation orchestration point. Prepare Assets, submit the provider-neutral request, poll the local generation using the existing UI polling cadence, and update the pre-created target video node with `resultAssetId` plus a fresh Asset display URL.

- [ ] **Step 7: Run focused checks**

Run: `bun --cwd web run test -- src/services/api/artbox.test.ts src/services/hosted-media.test.ts src/services/canvas-recovery/draft-snapshot.test.ts`

Run: `bun --cwd web run typecheck`

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src/services/api web/src/services/hosted-media.ts web/src/types web/src/components/canvas/canvas-node-generation.ts web/src/lib/canvas web/src/pages/canvas/project.tsx web/src/stores/use-config-store.ts web/src/services/canvas-recovery/draft-snapshot.test.ts
git commit -m "feat: connect canvas to hosted ArtBox video"
```

### Task 4: Deployment contract and milestone verification

**Files:**
- Modify: `.env.example`
- Create: `docs/content/docs/development/artbox-cos.zh-CN.mdx`
- Modify: `docs/content/docs/development/meta.zh-CN.json`
- Modify: `docs/designs/2026-08-29-artbox-provider-media-input.md`
- Test: `server/test/app-runtime.test.ts`

**Interfaces:**
- Consumes: the complete Asset, ArtBox, and Canvas slices.
- Produces: an operator-visible configuration contract and verified same-origin deployment behavior.

- [ ] **Step 1: Write a failing runtime registration test**

Assert that fully configured runtime registers Asset and ArtBox routes, omitted integration configuration keeps unrelated server routes healthy, and partial blocks fail before listening without including any secret in the error.

- [ ] **Step 2: Run the runtime test to verify red**

Run: `bun --cwd server run test -- test/app-runtime.test.ts`

Expected: FAIL until registration behavior is fully wired.

- [ ] **Step 3: Complete configuration examples and operator documentation**

Document Tencent COS CORS for the deployed web origin, private-bucket policy, all required server-only variables, ArtBox HTTPS base URL, exact model allowlist, the existing Nginx `/api` proxy requirement, local development origins, and a curl smoke test that uses an authenticated application session without printing Provider credentials.

- [ ] **Step 4: Run milestone verification**

Run: `bun --cwd server run test -- test/assets test/artbox test/config.test.ts test/app-runtime.test.ts test/database/migration-upgrade.test.ts`

Run: `bun --cwd server run typecheck`

Run: `bun --cwd server run check:boundaries`

Run: `bun --cwd web run test -- src/services/api/artbox.test.ts src/services/hosted-media.test.ts src/services/canvas-recovery/draft-snapshot.test.ts`

Run: `bun --cwd web run typecheck`

Expected: all PASS with no uncommitted generated artifacts.

- [ ] **Step 5: Inspect scope and secrets**

Run: `git diff origin/main --name-only`

Run: `git diff origin/main | rg -n "credits|ledger|billing|WORKSPACE_ADMIN_PURPOSES|Bearer [A-Za-z0-9]|SecretKey|API_KEY="`

Expected: no prohibited module edits and no credential values.

- [ ] **Step 6: Commit**

```bash
git add .env.example docs/content/docs/development docs/designs server/test/app-runtime.test.ts
git commit -m "docs: document ArtBox COS deployment"
```
