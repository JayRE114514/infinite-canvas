# Frontend Cutover and Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the user experience from browser-direct platform calls to authenticated backend models/tasks, add minimal administration, and deploy the API/Worker/web stack with actionable observability and release acceptance.

**Architecture:** Existing Canvas and workbench UI reuse their high-level generation promises while a new platform generation service creates durable Tasks and follows SSE events. User configuration stores only preferences and selected platform model IDs; Provider secrets and executable adapters exist only on the server.

**Tech Stack:** React 19, TanStack Query, Zustand, Fastify, Better Auth, SSE, Docker, Nginx, PostgreSQL, S3-compatible storage, Pino/OpenTelemetry-compatible structured telemetry.

**Spec:** `docs/superpowers/specs/2026-08-26-backend-platform-architecture-design.md`

## Global Constraints

- Depends on all prior plans.
- Preserve existing Canvas interaction and node-generation behavior; change the service boundary rather than rewriting Canvas UI.
- Ordinary users cannot see Provider Base URLs, secrets, route configuration, or executable scripts.
- Signed media URLs are ephemeral and are never persisted into Canvas snapshots or durable Zustand state.
- API and Worker deploy separately; one combined all-in-one container is not the production target.
- Write tests and provide commands without executing tests, typechecks, builds, or browser automation.

---

### Task 1: Platform Model Catalog and Generation Client

**Files:**
- Create: `web/src/services/api/models.ts`
- Create: `web/src/services/api/ai-tasks.ts`
- Create: `web/src/services/platform-generation.ts`
- Create: `web/src/hooks/use-platform-models.ts`
- Create: `web/src/stores/use-generation-store.ts`
- Create: `web/src/services/api/ai-tasks.test.ts`
- Modify: `web/package.json`

**Interfaces:**
- Produces: `listModels(capability?)`, `createAiTask`, `getAiTask`, `cancelAiTask`, and `subscribeTaskEvents`.
- Produces: `generatePlatformMedia(input, options): Promise<GeneratedAsset[]>`.

- [ ] **Step 1: Add Task client replay tests**

Add `vitest` and `eventsource-parser` to `web/package.json`, and add a `test` script that runs Vitest without a browser.

```ts
it('reconnects SSE with the last received sequence', async () => {
  await subscribeTaskEvents('w1', 't1', { lastEventId: 7, onEvent, signal: AbortSignal.timeout(50) })
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/workspaces/w1/ai-tasks/t1/events', expect.objectContaining({
    headers: expect.objectContaining({ 'Last-Event-ID': '7' }), credentials: 'include',
  }))
})
```

- [ ] **Step 2: Implement model catalog queries**

Use TanStack Query key `['models', capability]`. Model records expose supported controls and decimal-string pricing display. UI components must render only declared aspect ratios, resolutions, quality values, output counts, and reference limits.

- [ ] **Step 3: Implement durable generation client**

```ts
export async function generatePlatformMedia(input: PlatformGenerationInput, options: GenerationOptions) {
  const idempotencyKey = options.idempotencyKey || crypto.randomUUID()
  const task = await createAiTask(options.workspaceId, input, idempotencyKey)
  return waitForTask(task.taskId, {
    workspaceId: options.workspaceId,
    signal: options.signal,
    onEvent: options.onEvent,
  })
}
```

`subscribeTaskEvents` uses credentialed `fetch` plus the maintained `eventsource-parser` package so it can send `Last-Event-ID`; do not hand-write an SSE parser. `waitForTask` follows SSE, periodically fetches authoritative Task state after reconnect, resolves only with ready Asset records, throws `PlatformTaskError` for failed/cancelled, and keeps `reconciling` visible without inventing failure.

- [ ] **Step 4: Keep task state independent from Canvas component state**

`useGenerationStore` indexes Task summaries by Task ID and Workspace ID. Canvas nodes retain their own presentation state but reference the server Task ID for retry/status restoration.

- [ ] **Step 5: Hand verification to the user**

```bash
bun --cwd web test src/services/api/ai-tasks.test.ts
```

Expected: task creation sends a stable idempotency key, SSE replay resumes from the last sequence, and terminal Task responses normalize into Assets.

- [ ] **Step 6: Commit**

```bash
git add web/src/services web/src/hooks web/src/stores/use-generation-store.ts web/package.json bun.lock
git commit -m "feat: add platform generation client"
```

### Task 2: Replace Image Generation Entry Points

**Files:**
- Modify: `web/src/services/api/image.ts`
- Modify: `web/src/pages/image/index.tsx`
- Modify: `web/src/pages/canvas/project.tsx`
- Modify: `web/src/pages/canvas/hooks/use-plugin-host.tsx`
- Modify: `web/src/components/canvas/canvas-node-generation.ts`
- Modify: `web/src/types/image.ts`

**Interfaces:**
- Consumes: `generatePlatformMedia` from Task 1.
- Preserves: `requestGeneration` and `requestEdit` high-level return shape until all consumers migrate.

- [ ] **Step 1: Add a compatibility adapter at the existing service boundary**

```ts
export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions) {
  const assets = await generatePlatformMedia(toPlatformImageInput(config, prompt, []), {
    workspaceId: requireActiveWorkspaceId(), signal: options?.signal,
    idempotencyKey: options?.idempotencyKey,
  })
  return Promise.all(assets.map(resolveGeneratedImage))
}
```

`requestEdit` uploads or resolves reference images to Asset IDs first, then sends those IDs. It never sends browser API keys, Base URLs, scripts, or raw signed URLs.

- [ ] **Step 2: Remove per-result duplicate platform submissions**

For multi-image generation, create one Task with `outputCount`; do not loop `requestGeneration` N times. Canvas multi-image slots map to Task output indexes and display one server failure without charging phantom requests.

- [ ] **Step 3: Restore task status after refresh**

Canvas nodes persist `generationTaskId` and output Asset IDs. On project load, nonterminal Task IDs are queried and re-subscribed. Failed slots use a new idempotency key only when the user explicitly retries that slot.

- [ ] **Step 4: Keep local plugins separate**

Existing client-only Canvas extension plugins may still operate locally, but they cannot register Provider routes or server scripts. `use-plugin-host.tsx` calls the platform generation service for platform-funded generation.

- [ ] **Step 5: Give the user the manual acceptance checklist**

1. Generate one 16:9 image and verify stored pixel dimensions match the selected model capability.
2. Generate four images and verify one Task/Hold and four outputs, not four unrelated charges.
3. Refresh during generation and confirm progress resumes.
4. Force a sanitized Provider failure and confirm no HTML error appears.
5. Retry one failed slot and confirm successful existing outputs remain unchanged.

- [ ] **Step 6: Commit**

```bash
git add web/src/services/api/image.ts web/src/pages/image web/src/pages/canvas web/src/components/canvas web/src/types/image.ts CHANGELOG.md docs/content/docs/progress
git commit -m "feat: route image generation through platform tasks"
```

### Task 3: Remove User Provider Secrets and Arbitrary Scripts

**Files:**
- Modify: `web/src/stores/use-config-store.ts`
- Modify: `web/src/pages/config/index.tsx`
- Modify: `web/src/components/layout/app-config-modal.tsx`
- Remove from user flow: `web/src/components/layout/channel-editor-drawer.tsx`
- Remove from user flow: `web/src/components/layout/model-script-editor.tsx`
- Modify: `web/src/components/layout/model-select-modal.tsx`
- Modify: `web/src/components/model-picker.tsx`
- Modify: `web/src/components/audio-settings-panel.tsx`
- Modify: `web/src/components/image-settings-panel.tsx`
- Modify: `web/src/components/text-settings-panel.tsx`
- Modify: `web/src/components/video-settings-panel.tsx`
- Modify: `web/src/components/canvas/canvas-audio-settings-popover.tsx`
- Modify: `web/src/components/canvas/canvas-config-node-panel.tsx`
- Modify: `web/src/components/canvas/canvas-image-settings-popover.tsx`
- Modify: `web/src/components/canvas/canvas-node-prompt-panel.tsx`
- Modify: `web/src/components/canvas/canvas-text-settings-popover.tsx`
- Modify: `web/src/components/canvas/canvas-video-settings-popover.tsx`
- Modify: `web/src/lib/agent/agent-site-tools.ts`
- Modify: `web/src/lib/canvas/canvas-generation-helpers.ts`
- Modify: `web/src/lib/canvas/canvas-node-factory.ts`
- Modify: `web/src/pages/video/index.tsx`
- Modify: `web/src/services/api/audio.ts`
- Modify: `web/src/services/api/video.ts`
- Modify: `web/src/services/config-file.ts`
- Modify: `web/src/services/app-sync.ts`
- Modify: `web/src/services/webdav-sync.ts`
- Modify: `web/src/components/layout/client-root-init.tsx`
- Modify: `web/src/i18n/locales/en-US.ts`
- Modify: `web/src/i18n/locales/zh-CN.ts`

**Interfaces:**
- Produces: `AiPreferences` containing selected model IDs and UI generation preferences only.
- Consumes: server Model catalog capabilities.

- [ ] **Step 1: Replace persisted configuration shape**

```ts
export type AiPreferences = {
  imageModelId: string
  videoModelId: string
  textModelId: string
  audioModelId: string
  imageAspectRatio: string
  imageResolution: string
  imageQuality: string
  imageCount: number
  videoDurationSeconds: number
}
```

Do not preserve or migrate `apiKey`, `baseUrl`, `channels`, or model `script` into the new store. The project is not launched, so the new storage key replaces the old shape without compatibility branches. Update every listed `AiConfig` consumer to read `AiPreferences` and model capabilities; when the server has no enabled model for video, audio, or text, show that capability as unavailable instead of falling back to a browser-direct request.

- [ ] **Step 2: Replace channel UI with platform model preferences**

The ordinary Config page shows preference controls driven by Model capabilities. Remove pull-model, arbitrary endpoint, API Key, and invocation-script entry points from normal navigation.

- [ ] **Step 3: Remove secrets from configuration export/import**

Export only preferences, prompt sources, theme, and allowed local settings. Ignore legacy secret fields on import rather than persisting them. Add a user-facing notice that Provider credentials are platform-managed.

Disable WebDAV synchronization for Canvas, Asset, Wallet, and Task business data now owned by the server. Remove the WebDAV configuration tab from the account-mode UI and stop `ClientRootInit` from starting the old business-data sync loop. Do not silently delete the user's old local WebDAV settings; leave them outside the new account data path until an explicit local-export feature needs them.

- [ ] **Step 4: Add runtime fail-closed checks**

Search production web source for `new Function`, `apiKey`, and `Authorization` generation paths. The model plugin runtime may remain only for explicitly local non-provider extensions; platform generation imports none of it.

- [ ] **Step 5: Give the user the manual acceptance checklist**

1. Confirm ordinary users cannot enter an API Key, Base URL, or JavaScript model script.
2. Confirm configuration export contains no secrets.
3. Confirm Model Picker shows only enabled server models and supported controls.
4. Confirm old local secret fields are not copied into the new preference store.

- [ ] **Step 6: Commit**

```bash
git add web/src/stores/use-config-store.ts web/src/pages/config web/src/components/layout web/src/components/model-picker.tsx web/src/services/config-file.ts web/src/i18n CHANGELOG.md docs/content/docs/progress
git commit -m "feat: make provider configuration server-owned"
```

### Task 4: Minimal Billing, Task, and Provider Administration UI

**Files:**
- Create: `web/src/pages/admin/layout.tsx`
- Create: `web/src/pages/admin/workspaces/index.tsx`
- Create: `web/src/pages/admin/tasks/index.tsx`
- Create: `web/src/pages/admin/providers/index.tsx`
- Create: `web/src/pages/admin/components/wallet-adjustment-modal.tsx`
- Create: `web/src/services/api/admin.ts`
- Create: `web/src/pages/settings/billing/index.tsx`
- Modify: `web/src/router.tsx`
- Modify: `web/src/components/layout/app-top-nav.tsx`
- Modify: `web/src/i18n/locales/en-US.ts`
- Modify: `web/src/i18n/locales/zh-CN.ts`

**Interfaces:**
- Consumes: Wallet/Ledger and `/api/v1/admin/*` routes.
- Produces: member Wallet summary and platform-admin management pages.

- [ ] **Step 1: Add member Wallet view**

Show available, held, and status for the active Workspace. Owner/admin can open cursor-paginated Ledger history. Members receive a stable permission explanation instead of retry loops.

- [ ] **Step 2: Add atomic adjustment modal**

Require signed integer amount, nonempty reason, confirmation, and a generated idempotency key. After success, invalidate Wallet and Ledger queries. Never optimistically mutate balances.

- [ ] **Step 3: Add Task/reconciliation page**

Filter by Task state, Provider route, Workspace, and age. For reconciling Tasks show sanitized attempt metadata and explicit confirm-charge/confirm-no-charge actions with a mandatory reason.

- [ ] **Step 4: Add Provider route page**

Allow only enabling/disabling pre-registered routes and editing inert concurrency/timeout/model route data supported by the API. Do not expose a code editor, plugin upload, or arbitrary Adapter key field.

- [ ] **Step 5: Give the user the manual acceptance checklist**

1. Non-admin cannot route to `/admin` or call admin APIs.
2. Admin adjusts points once under double submit.
3. Freeze blocks new Hold while reads continue.
4. Reconciliation action changes Task, Billing, Wallet, Ledger, event, and audit together.
5. Provider page cannot create an unknown Adapter.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/admin web/src/pages/settings web/src/services/api/admin.ts web/src/router.tsx web/src/components/layout/app-top-nav.tsx web/src/i18n CHANGELOG.md docs/content/docs/progress
git commit -m "feat: add platform administration views"
```

### Task 5: Production Containers and Local Infrastructure

**Files:**
- Create: `server/Dockerfile`
- Modify: `Dockerfile`
- Modify: `nginx.conf`
- Modify: `docker-compose.local.yml`
- Modify: `docker-compose.yml`
- Create: `server/src/migrate.ts`
- Modify: `.dockerignore`
- Modify: `.env.example`

**Interfaces:**
- Produces separate image commands for API, Worker, migration, and web.

- [ ] **Step 1: Split production images**

`server/Dockerfile` builds server/contracts under Bun and runs compiled JavaScript on `node:24-alpine` as a non-root user. The root `Dockerfile` remains the sole web image, builds Vite from the root Bun workspace, and serves static files through Nginx; replace its browser-direct AI comment with the same-origin platform topology.

- [ ] **Step 2: Route same-origin API traffic**

Nginx proxies `/api/` to the API service with request IDs and buffering disabled for `text/event-stream`; static routes retain SPA fallback. Media uploads do not proxy through Nginx because clients use presigned object-store URLs.

- [ ] **Step 3: Add local Compose services**

Local compose includes PostgreSQL with health check, MinIO plus bucket initialization, Mailpit, migration job, API, Worker, and web. API waits for migration success; Worker waits for database and migration. Use named volumes and no hardcoded production secrets.

- [ ] **Step 4: Keep production dependencies external**

Production compose accepts managed `DATABASE_URL` and S3 settings and does not deploy a fake single-host HA database. Document that two API replicas, independently scaled Workers, managed PostgreSQL/PITR, and object storage are production requirements.

- [ ] **Step 5: Give the user the manual acceptance commands**

```bash
docker compose -f docker-compose.local.yml up --build
```

Expected: migration exits successfully; two application processes start; `/api/v1/health/live` and `/ready` succeed; the web app signs in; MinIO receives direct uploads; SSE remains unbuffered.

- [ ] **Step 6: Commit**

```bash
git add server/Dockerfile Dockerfile nginx.conf docker-compose.local.yml docker-compose.yml server/src/migrate.ts .dockerignore .env.example
git commit -m "feat: deploy separate API and worker services"
```

### Task 6: Structured Observability and Security Limits

**Files:**
- Create: `server/src/infrastructure/observability/request-context.ts`
- Create: `server/src/infrastructure/observability/metrics.ts`
- Create: `server/src/infrastructure/observability/redaction.ts`
- Create: `server/src/infrastructure/security/ssrf.ts`
- Create: `server/src/infrastructure/security/limits.ts`
- Create: `server/test/security/ssrf.test.ts`
- Create: `server/test/observability/redaction.test.ts`
- Create: `server/test/load/api-and-tasks.js`
- Modify: `server/package.json`
- Modify: `server/src/app.ts`
- Modify: `server/src/worker.ts`

**Interfaces:**
- Produces redacted JSON logs and metric names documented below.
- Produces `assertAllowedProviderUrl(url): Promise<void>`.

- [ ] **Step 1: Add redaction and SSRF tests**

Add `ipaddr.js` and `prom-client` to `server/package.json`; use them for IP range classification and bounded Prometheus metrics instead of handwritten IP parsing or metric storage.

```ts
it.each(['http://127.0.0.1', 'http://169.254.169.254/latest/meta-data', 'http://[::1]', 'http://10.0.0.1'])
  ('rejects provider URL %s', async (url) => {
    await expect(assertAllowedProviderUrl(url)).rejects.toMatchObject({ code: 'provider_url_forbidden' })
  })

it('redacts credentials from structured metadata', () => {
  expect(redact({ authorization: 'Bearer secret', apiKey: 'sk-secret', cookie: 'session=x' }))
    .toEqual({ authorization: '[REDACTED]', apiKey: '[REDACTED]', cookie: '[REDACTED]' })
})
```

- [ ] **Step 2: Configure request and Worker correlation**

Logs include requestId, userId, workspaceId, taskId, attemptId, and providerRouteId when available. Prompt text, response media, signed URLs, Cookie, Authorization, and secret values are excluded or redacted.

- [ ] **Step 3: Emit bounded operational metrics**

Expose HTTP latency/error, event-loop delay, DB pool, queue depth/age, Task state/age, Provider outcome/latency, reconciliation count, active Hold age, and billing-invariant counts. Do not use unbounded user/workspace/task IDs as metric labels.

- [ ] **Step 4: Add process limits**

Configure API body limits, route timeouts, graceful shutdown, DB pool budget, Workspace/platform/route task concurrency, and Worker stop-claim behavior. `assertAllowedProviderUrl` resolves every A/AAAA address, rejects non-public results, disables automatic redirects, and repeats validation for any explicitly handled redirect to reduce DNS rebinding and redirect-based SSRF risk. API readiness fails when PostgreSQL is unavailable; liveness remains process-only.

- [ ] **Step 5: Hand verification to the user**

```bash
bun --cwd server run test -- test/security/ssrf.test.ts test/observability/redaction.test.ts
```

Expected: private/metadata destinations fail, credentials are absent from logs, metrics avoid high-cardinality IDs, and graceful shutdown stops new work before exiting.

The user also runs the k6 scenario against a mocked Provider:

```bash
k6 run -e BASE_URL=http://localhost:3000 server/test/load/api-and-tasks.js
```

The script ramps to 200 authenticated virtual users, caps active mocked AI work at 20, and asserts zero negative Wallets, zero duplicate settlements, HTTP error rate below 1%, and control-plane p95 below 500 ms on the agreed staging instance.

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/src/infrastructure server/test/security server/test/observability server/test/load server/src/app.ts server/src/worker.ts
git commit -m "feat: add platform security and observability"
```

### Task 7: Release Documentation and Human Acceptance Gate

**Files:**
- Modify: `README.md`
- Modify: `docs/index.md`
- Modify: `docs/index.zh-CN.md`
- Create: `docs/content/docs/development/backend-platform.mdx`
- Create: `docs/content/docs/development/backend-platform.zh-CN.mdx`
- Modify: `docs/content/docs/development/meta.json`
- Modify: `docs/content/docs/development/meta.zh-CN.json`
- Modify: `docs/content/docs/overview/features.mdx`
- Modify: `docs/content/docs/overview/features.zh-CN.mdx`
- Modify: `docs/content/docs/progress/todo.mdx`
- Modify: `docs/content/docs/progress/todo.zh-CN.mdx`
- Modify: `docs/content/docs/progress/pending-test.mdx`
- Modify: `docs/content/docs/progress/pending-test.zh-CN.mdx`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces production setup, recovery, security, and acceptance documentation.

- [ ] **Step 1: Document the supported production topology**

Describe separate API/Worker/web services, managed PostgreSQL with PITR, private object storage, migration release job, environment variables, secret handling, health endpoints, and the fact that single-host Compose is development-only.

- [ ] **Step 2: Document recovery runbooks**

Include procedures for queue backlog, stale submitting, reconciling Tasks, storage orphan cleanup, frozen Wallet, billing invariant alert, database restore, and Provider route disablement. Every financial runbook uses application admin actions or compensating entries, never direct balance edits.

- [ ] **Step 3: Move completed work into pending test**

Remove implemented backend items from both TODO files and add itemized manual verification to both pending-test files. Add concise `[新增]`, `[调整]`, and `[修复]` Unreleased entries without duplicating implementation detail.

- [ ] **Step 4: Give the user the final acceptance matrix**

The human tester executes:

1. Email registration, verification, one-time grant, login restore, and logout.
2. Personal/team Workspace isolation and role checks.
3. Canvas create/save/reload/revision conflict.
4. Direct Asset upload/download/delete and cross-Workspace denial.
5. Image success with correct aspect ratio, output count, one charge, and stored Assets.
6. Deterministic Provider failure with full Hold release.
7. Ambiguous timeout with reconciling status and retained Hold.
8. Duplicate submit, Worker restart, SSE reconnect, and exactly-once settlement.
9. Admin adjustment/freeze/reconciliation with audit entries.
10. Log inspection confirming no API keys, cookies, signed URLs, prompt text, raw HTML, or stack traces reach the browser.

- [ ] **Step 5: Commit the pending-test release documentation**

```bash
git add README.md docs/index.md docs/index.zh-CN.md docs/content/docs/development docs/content/docs/progress CHANGELOG.md
git commit -m "docs: document backend platform release"
```

- [ ] **Step 6: Update formal features only after explicit user confirmation**

If and only if the user confirms the acceptance matrix passed, move the verified behavior from pending-test into both `features.mdx` files and commit:

```bash
git add docs/content/docs/overview/features.mdx docs/content/docs/overview/features.zh-CN.mdx docs/content/docs/progress/pending-test.mdx docs/content/docs/progress/pending-test.zh-CN.mdx
git commit -m "docs: confirm backend platform features"
```
