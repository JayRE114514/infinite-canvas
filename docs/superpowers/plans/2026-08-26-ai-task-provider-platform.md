# AI Task and Provider Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one reliable platform-funded image-generation path with atomic points reservation, durable jobs, owner-maintained Provider adapters, private output Assets, replayable progress, and ambiguous-outcome reconciliation.

**Architecture:** The API validates normalized model capabilities and atomically creates Task, Billing Order, Hold, Attempt, event, and pg-boss job. A separate Worker performs remote I/O without holding database transactions, classifies outcomes, stores outputs through the Asset service, and terminalizes billing exactly once.

**Tech Stack:** Fastify 5, TypeBox, Drizzle ORM, PostgreSQL, pg-boss Drizzle transaction adapter, AWS SDK S3 storage, native fetch/Undici, Vitest, Testcontainers.

**Spec:** `docs/superpowers/specs/2026-08-26-backend-platform-architecture-design.md`

## Global Constraints

- Depends on cloud Canvas/Asset and Workspace billing plans.
- The first production adapter targets the user-documented OpenAI-compatible `POST /v1/images/generations` contract.
- Provider credentials are resolved by `secretRef` from server secrets and never stored in Task input, job payload, response, or log.
- Jobs contain only `{ taskId }`.
- A remote timeout is not proof of failure. Retry only `safe_retry`; retain Hold for `ambiguous`.
- Task state, Billing state, and task events transition in one PostgreSQL transaction.
- No user-provided JavaScript, dynamic module, arbitrary npm install, or arbitrary server URL is executed.
- Write tests and provide commands without executing tests, typechecks, builds, or browser automation.

---

### Task 1: Model Catalog, Task Schema, and Provider Interfaces

**Files:**
- Create: `packages/contracts/src/models.ts`
- Create: `packages/contracts/src/ai-tasks.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `server/src/modules/providers/types.ts`
- Create: `server/src/modules/providers/registry.ts`
- Create: `server/src/modules/providers/secrets.ts`
- Create: `server/src/modules/providers/model-routes.ts`
- Create: `server/src/modules/ai-tasks/schema.ts`
- Create: `server/migrations/0004_ai_tasks.sql`
- Create: `server/test/providers/registry.test.ts`
- Create: `server/test/ai-tasks/schema.test.ts`
- Modify: `server/src/infrastructure/database/schema.ts`

**Interfaces:**
- Produces: `GenerationInput`, `ProviderAdapter`, `SubmitOutcome`, `PollOutcome`, `ProviderFailure`, `ProviderRoute`.
- Produces: tables `models`, `providerRoutes`, `aiTasks`, `providerAttempts`, and `taskEvents`.
- Produces: authenticated `GET /api/v1/models` and `GET /api/v1/models/:modelId`.

- [ ] **Step 1: Add capability validation tests**

```ts
it('rejects quality when the selected model does not declare quality support', () => {
  const result = validateGenerationInput(geminiImageModel, {
    kind: 'image', prompt: 'test', referenceAssetIds: [], aspectRatio: '16:9', resolution: '2K', quality: 'high', outputCount: 1,
  })
  expect(result).toEqual({ ok: false, code: 'unsupported_model_parameter', parameter: 'quality' })
})

it('does not register adapters from database configuration', () => {
  expect(() => registry.require('https://example.com/plugin.js')).toThrow('Unknown provider adapter')
})
```

- [ ] **Step 2: Define discriminated generation contracts**

```ts
export const ImageGenerationInputSchema = Type.Object({
  kind: Type.Literal('image'),
  prompt: Type.String({ minLength: 1, maxLength: 20_000 }),
  referenceAssetIds: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 10, uniqueItems: true }),
  aspectRatio: Type.Optional(Type.String({ maxLength: 20 })),
  resolution: Type.Optional(Type.String({ maxLength: 20 })),
  quality: Type.Optional(Type.String({ maxLength: 20 })),
  outputCount: Type.Integer({ minimum: 1, maximum: 15 }),
})
```

Video, audio, and text variants are defined now for schema stability but remain disabled until a model and Adapter declare support.

- [ ] **Step 3: Define static Adapter interfaces and registry**

```ts
export class ProviderRegistry {
  constructor(private readonly adapters: ReadonlyMap<string, ProviderAdapter>) {}
  require(key: string) {
    const adapter = this.adapters.get(key)
    if (!adapter) throw new Error(`Unknown provider adapter: ${key}`)
    return adapter
  }
}
```

The application constructs the map from source imports only. `ProviderRoute.configJson` is inert validated JSON.

- [ ] **Step 4: Add model and task tables**

Models store capability, validated parameter schema, price configuration, enabled flag, and timestamps. Provider Routes store Adapter key, fixed base URL, exact upstream model ID, secret reference, priority, inert config, and enabled flag. AI Tasks enforce `(workspace_id,idempotency_key)` unique. Attempts enforce `(task_id,attempt_number)` and `(adapter_key,provider_idempotency_key)` unique. Task Events enforce `(task_id,sequence)` unique.

Pricing configuration declares whether charging is per request or per successful output and whether verified Provider usage overrides calculated usage. This policy is part of the immutable Billing Order price snapshot; the Worker never guesses charging from HTTP status alone.

Register authenticated model-list/detail routes that return enabled platform models and sanitized capabilities/pricing only. They never return Provider Route IDs, base URLs, secret references, or upstream credentials.

- [ ] **Step 5: Hand verification to the user**

```bash
bun --cwd server test test/providers/registry.test.ts test/ai-tasks/schema.test.ts
```

Expected: unsupported parameters are rejected, unknown adapter keys fail closed, and database uniqueness prevents duplicate task/attempt/event identities.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src server/src/modules/providers server/src/modules/ai-tasks server/migrations server/test/providers server/test/ai-tasks server/src/infrastructure/database
git commit -m "feat: add model and AI task domain"
```

### Task 2: Atomic Task Creation and pg-boss Enqueue

**Files:**
- Create: `server/src/infrastructure/queue/boss.ts`
- Create: `server/src/modules/ai-tasks/pricing.ts`
- Create: `server/src/modules/ai-tasks/events.ts`
- Create: `server/src/modules/ai-tasks/service.ts`
- Create: `server/src/modules/ai-tasks/routes.ts`
- Create: `server/test/ai-tasks/create-task.test.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/api.ts`

**Interfaces:**
- Consumes: `reserveBillingOrder(tx, input)` and `fromDrizzle(tx, sql)`.
- Produces: `createAiTask(deps, access, request): Promise<CreateAiTaskResponse>`.
- Produces: `appendTaskEvent(tx, taskId, type, payload): Promise<number>`.

- [ ] **Step 1: Add atomicity and idempotency tests**

```ts
it('rolls back Task, Hold, ledger, and job together when enqueue fails', async () => {
  boss.send.mockRejectedValue(new Error('queue unavailable'))
  await expect(createAiTask(deps, access, request)).rejects.toThrow('queue unavailable')
  expect(await taskCount(db)).toBe(0)
  expect(await billingOrderCount(db)).toBe(0)
  expect(await walletBalance(db, access.workspaceId)).toEqual({ available: 1000n, held: 0n })
})

it('replays one Task for the same idempotency key and body', async () => {
  const first = await createAiTask(deps, access, request)
  const second = await createAiTask(deps, access, request)
  expect(second.taskId).toBe(first.taskId)
  expect(await queuedJobCount(first.taskId)).toBe(1)
})
```

- [ ] **Step 2: Implement immutable price snapshots**

`estimateTaskPrice(model, input)` returns a bigint maximum reservation and a JSON snapshot containing model ID, pricing version, capability, parameter multipliers, output count, estimated amount, and currency `POINT`. It rejects disabled models and unpriced parameter combinations.

- [ ] **Step 3: Implement one transaction for task creation**

```ts
return db.transaction(async (tx) => {
  const replay = await findIdempotentTask(tx, access.workspaceId, request.idempotencyKey, request.requestHash)
  if (replay) return replay
  const task = await insertQueuedTask(tx, access, request)
  const order = await reserveBillingOrder(tx, { taskId: task.id, workspaceId: access.workspaceId, ...price })
  await insertInitialAttempt(tx, task, route)
  await appendTaskEvent(tx, task.id, 'task.queued', {})
  await boss.send('ai-image', { taskId: task.id }, {
    db: fromDrizzle(tx, sql), singletonKey: task.id, retryLimit: 5,
  })
  return { taskId: task.id, status: 'queued', estimatedPoints: order.estimatedAmount.toString() }
})
```

- [ ] **Step 4: Add create/get/list/cancel routes**

Create reads `Idempotency-Key`, hashes `{ modelId, normalizedInput }` with `hashCanonicalRequest`, validates model capability and reference Asset ownership, and returns 202. Cancel releases immediately only while queued; submitting/processing cancellation records a request but does not refund until the Adapter confirms cancellation.

- [ ] **Step 5: Hand verification to the user**

```bash
bun --cwd server test test/ai-tasks/create-task.test.ts
```

Expected: enqueue failure leaves no financial or task rows, duplicate requests return one Task/job, body mismatch returns 409, and insufficient points create nothing.

- [ ] **Step 6: Commit**

```bash
git add server/src/infrastructure/queue server/src/modules/ai-tasks server/test/ai-tasks server/src/app.ts server/src/api.ts
git commit -m "feat: create AI tasks atomically"
```

### Task 3: OpenAI-Compatible Image Adapter

**Files:**
- Create: `server/src/modules/providers/openai-images.ts`
- Create: `server/src/modules/providers/catalog-seed.ts`
- Create: `server/test/providers/openai-images.test.ts`
- Create: `server/test/fixtures/providers/openai-images/b64-success.json`
- Create: `server/test/fixtures/providers/openai-images/url-success.json`
- Create: `server/test/fixtures/providers/openai-images/error.json`
- Create: `server/test/fixtures/providers/openai-images/502.html`
- Modify: `server/src/modules/providers/registry.ts`

**Interfaces:**
- Produces: `OpenAiImagesAdapter` with key `openai-images`.
- Consumes route config `{ path: '/images/generations', responseFormat?: 'b64_json', sizeMap: Record<string, string> }`.

- [ ] **Step 1: Add exact request-mapping tests**

```ts
it('sends only model-supported image fields', async () => {
  await adapter.submit(contextFor(
    { aspectRatio: '16:9', resolution: undefined, quality: 'medium', outputCount: 2 },
    { sizeMap: { '16:9': '1792x1024' } },
  ))
  expect(fetchMock.body()).toEqual({
    model: 'grok-imagine-image-2.0', prompt: 'A quiet observatory', size: '1792x1024', quality: 'medium', n: 2,
  })
})

it('never duplicates duration or sends video fields in an image request', async () => {
  await adapter.submit(contextFor({ aspectRatio: '1:1', outputCount: 1 }))
  expect(JSON.stringify(fetchMock.body())).not.toContain('duration')
})
```

- [ ] **Step 2: Implement fixed URL and header construction**

Resolve the base URL from the approved Provider Route, join the fixed `/images/generations` path without accepting a request path from users, and send `Authorization: Bearer <secret>` plus JSON content type. Apply connect/headers/body deadline through `AbortSignal.timeout` and cap response bytes before parsing. Omit `response_format` by default because the documented Wawazz example does not send it; include `b64_json` only when the reviewed route config explicitly enables it. Never invent a ratio-to-size conversion: the route's verified `sizeMap` is the sole mapping source.

- [ ] **Step 3: Normalize URL and Base64 responses**

Accept only `data[].url` with HTTPS or `data[].b64_json` whose decoded length is below the configured maximum. Empty `data`, malformed JSON, or success without media becomes terminal `provider_no_output`; never return raw HTML.

- [ ] **Step 4: Classify failures**

400/401/403/404 are terminal. A route may classify an explicit documented pre-admission 429/503 as safe retry with bounded Retry-After. Once `fetch` has been invoked, generic transport failures, timeout, disconnect, and HTML 502 are ambiguous unless that Provider contract proves the request was not accepted; do not infer body-transmission state from an Undici error.

- [ ] **Step 5: Add the reviewed catalog seed**

Add an idempotent catalog seed command that reads the reviewed `WAWAZZ_IMAGE_MODEL_ID`, `WAWAZZ_IMAGE_SIZE_MAP`, and integer point price, inserts the platform model and `openai-images` route, and references the allowlisted secret name `PROVIDER_SECRET_WAWAZZ`. Reject malformed maps or a model capability not represented by that map.

- [ ] **Step 6: Hand verification to the user**

```bash
bun --cwd server test test/providers/openai-images.test.ts
```

Expected: request JSON matches the documented Wawazz OpenAI-compatible contract, URL/Base64 fixtures normalize, and HTML/timeout fixtures return sanitized classifications.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/providers server/test/providers server/test/fixtures/providers
git commit -m "feat: add OpenAI-compatible image adapter"
```

### Task 4: Worker State Machine, Output Storage, and Settlement

**Files:**
- Create: `server/src/modules/ai-tasks/worker.ts`
- Create: `server/src/modules/ai-tasks/state-machine.ts`
- Create: `server/src/modules/ai-tasks/output.ts`
- Create: `server/src/worker.ts`
- Create: `server/test/ai-tasks/worker.test.ts`
- Modify: `server/src/infrastructure/queue/boss.ts`

**Interfaces:**
- Consumes: `ProviderRegistry`, `AssetStorage`, `settleBillingOrder`, `releaseBillingOrder`, `appendTaskEvent`.
- Produces: `processAiImageJob(job: { data: { taskId: string } }): Promise<void>`.
- Produces: `transitionTask(tx, taskId, from, to, patch): Promise<void>`.

- [ ] **Step 1: Add crash/retry and exactly-once settlement tests**

```ts
it('does not call the provider again after output entered storing', async () => {
  await seedTask({ status: 'storing', normalizedOutput: httpsOutput })
  await processAiImageJob(job)
  expect(adapter.submit).not.toHaveBeenCalled()
  expect(storage.copyRemoteOutput).toHaveBeenCalledOnce()
})

it('settles one financial effect when the same job runs twice', async () => {
  await Promise.all([processAiImageJob(job), processAiImageJob(job)])
  expect(adapter.submit).toHaveBeenCalledOnce()
  expect(await settlementCount(task.billingOrderId)).toBe(1)
})
```

- [ ] **Step 2: Implement leased state transitions**

Claim only `queued` tasks with a conditional update to `submitting`, set heartbeat and lease expiry, then commit before remote I/O. Transition methods require the exact allowed prior state. A duplicate worker that loses the condition exits without side effects.

- [ ] **Step 3: Persist remote acceptance immediately**

For `accepted`, persist `remoteTaskId`, attempt status, heartbeat, `processing`, event, and a singleton `provider-poll` job in one transaction. For synchronous output, persist a normalized output descriptor and `storing` before copying whenever the output can be referenced again.

- [ ] **Step 4: Store output and terminalize atomically**

Copy HTTPS output by streaming with MIME/size limits; decode Base64 in the Worker with a strict maximum and immediately upload. After all Assets are ready, one transaction links output Asset IDs, marks Task succeeded, appends event, settles Billing Order, and closes the Attempt.

If the route contract permits partial output and at least one valid output exists, store the valid Assets and complete the Task with `result.expectedOutputCount`, `result.outputs`, and `result.failedOutputCount`. Settle according to the snapshotted per-request/per-output policy or verified Provider usage. If the actual charge cannot be determined safely, enter `reconciling` instead of guessing or refunding.

- [ ] **Step 5: Handle failure classifications**

`terminal` marks failed and releases Hold. `safe_retry` closes the current Attempt, creates the next numbered Attempt with a new Provider idempotency key, returns Task to queued, and throws a retryable job error within the bounded attempt count. `ambiguous` marks reconciling, retains Hold, appends a public sanitized event, and does not throw a job retry that would resubmit.

Remote output copying validates every resolved address and redirect with the same SSRF policy as Provider base URLs. It accepts only HTTPS and a configured output-host allowlist when the Provider can publish one.

- [ ] **Step 6: Hand verification to the user**

```bash
bun --cwd server test test/ai-tasks/worker.test.ts
```

Expected: duplicate jobs submit/settle once, storage retry does not regenerate, terminal failure refunds, and ambiguous timeout retains Hold.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/ai-tasks server/src/worker.ts server/src/infrastructure/queue server/test/ai-tasks
git commit -m "feat: process and settle AI image tasks"
```

### Task 5: Durable SSE Task Events

**Files:**
- Create: `server/src/modules/ai-tasks/sse.ts`
- Create: `server/test/ai-tasks/sse.test.ts`
- Modify: `server/src/modules/ai-tasks/routes.ts`

**Interfaces:**
- Produces: `GET /api/v1/workspaces/:workspaceId/ai-tasks/:taskId/events`.
- Consumes: Task Events and `Last-Event-ID`.

- [ ] **Step 1: Add replay and authorization tests**

```ts
it('replays events strictly after Last-Event-ID', async () => {
  const response = await authenticatedInject(app, user, {
    method: 'GET', url: eventsUrl, headers: { 'last-event-id': '2' },
  })
  expect(await readSse(response)).toEqual([
    { id: '3', event: 'task.processing' },
    { id: '4', event: 'task.succeeded' },
  ])
})
```

- [ ] **Step 2: Implement durable replay before live wait**

Authorize Task ownership through Workspace, parse Last-Event-ID as a non-negative sequence, query later events in order, write `id`, `event`, and JSON `data`, then poll for later rows once per second with short independent queries. Rows remain authoritative; no database connection remains checked out between polls.

- [ ] **Step 3: Add heartbeat and shutdown behavior**

Send comment heartbeat every 15 seconds, stop on request abort, and close all connections during Fastify shutdown. Never keep a database connection checked out for the lifetime of an SSE stream.

- [ ] **Step 4: Hand verification to the user**

```bash
bun --cwd server test test/ai-tasks/sse.test.ts
```

Expected: replay order is stable, cross-Workspace subscription fails, heartbeat does not create Task Events, and disconnect releases resources.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/ai-tasks/sse.ts server/src/modules/ai-tasks/routes.ts server/test/ai-tasks/sse.test.ts
git commit -m "feat: stream durable AI task events"
```

### Task 6: Reaper, Reconciliation, and Provider Administration

**Files:**
- Create: `server/src/modules/ai-tasks/reaper.ts`
- Create: `server/src/modules/ai-tasks/reconciliation.ts`
- Create: `server/src/modules/admin/provider-routes.ts`
- Create: `server/src/modules/admin/task-routes.ts`
- Create: `server/test/ai-tasks/recovery.test.ts`
- Create: `server/test/admin/providers.test.ts`
- Modify: `server/src/worker.ts`
- Modify: `server/src/app.ts`

**Interfaces:**
- Produces: `reapExpiredTasks(now): Promise<RecoverySummary>`.
- Produces: `reconcileTask(taskId, actor): Promise<ReconciliationResult>`.

- [ ] **Step 1: Add recovery decision tests**

```ts
it.each([
  ['queued', null, 'requeue'],
  ['submitting', null, 'reconciling'],
  ['processing', 'remote-1', 'poll'],
  ['storing', null, 'resume-storage'],
])('recovers %s with remote id %s as %s', async (status, remoteTaskId, expected) => {
  expect(await recoveryDecision({ status, remoteTaskId })).toBe(expected)
})
```

- [ ] **Step 2: Implement the periodic Reaper**

Schedule a singleton maintenance job. Claim expired rows with `FOR UPDATE SKIP LOCKED`: queued is re-enqueued, submitting without remote ID becomes reconciling, processing with remote ID gets a poll job, and storing gets a storage-resume job. Terminal Tasks are ignored.

- [ ] **Step 3: Implement reconciliation**

When Adapter supports query by remote ID or Provider idempotency key, query and transition accordingly. Otherwise keep `review`, expose sanitized evidence to platform admins, and require an explicit `confirm-no-charge` or `confirm-charge` action. Both actions write Task Event, Billing effect, and Audit Log atomically.

- [ ] **Step 4: Implement Provider admin routes**

Admins can list/enable/disable existing statically known Adapter routes and update inert limits/pricing references. Reject Adapter keys absent from `ProviderRegistry`; reject private, loopback, link-local, and metadata-service base URLs.

- [ ] **Step 5: Hand verification to the user**

```bash
bun --cwd server test test/ai-tasks/recovery.test.ts test/admin/providers.test.ts
```

Expected: stale states choose safe recovery, unknown outcomes never auto-refund/resubmit, and admin configuration cannot register executable adapters or private-network URLs.

- [ ] **Step 6: Commit and update progress docs**

```bash
git add server/src/modules/ai-tasks server/src/modules/admin server/src/worker.ts server/src/app.ts server/test CHANGELOG.md docs/content/docs/progress
git commit -m "feat: recover and reconcile provider tasks"
```
