# Backend Platform Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the confirmed account, Workspace, cloud canvas, points ledger, durable AI-task, and owner-maintained Provider Adapter platform in reviewable phases.

**Architecture:** A TypeScript/Fastify modular monolith exposes a stateless API and an independently deployed Worker. PostgreSQL owns business state and pg-boss jobs; S3-compatible storage owns media bytes; the React frontend consumes shared runtime contracts.

**Tech Stack:** Bun 1.3.13 workspaces, Node.js 24 LTS, TypeScript strict mode, Fastify 5, TypeBox, Better Auth, Drizzle ORM, PostgreSQL, pg-boss, S3-compatible storage, React 19, TanStack Query, Zustand, Vitest, Testcontainers.

**Spec:** `docs/superpowers/specs/2026-08-26-backend-platform-architecture-design.md`

## Global Constraints

- Ordinary users cannot upload, install, or execute server-side Provider plugins; adapters are statically registered owner-authored modules.
- PostgreSQL is authoritative for Workspace membership, canvas revisions, points, billing orders, task state, task events, and jobs.
- Points use `BIGINT` integer units. Ledger history is append-only and every transaction balances to zero.
- AI calls never run inside an open database transaction.
- API processes do not resize, transcode, decode large Base64 payloads, or proxy media uploads/downloads.
- API and Worker are separate processes from the first deploy.
- MVP uses REST plus durable SSE replay and does not add Redis, payment, CRDT/OT, arbitrary plugins, or automatic cross-provider failover.
- Implementation agents write focused tests and list exact verification commands, but do not execute tests, typechecks, builds, or browser automation; the human tester runs them per `AGENTS.md`.
- Each completed user-visible slice updates `CHANGELOG.md`, `docs/content/docs/progress/todo.mdx`, and `docs/content/docs/progress/pending-test.mdx` together with their Chinese variants when applicable.

---

## Plan Set and Dependency Order

1. `2026-08-26-backend-foundation-identity-workspaces.md`
   - Establishes the workspace, Fastify application, PostgreSQL access, Better Auth, session guards, and personal/team Workspace APIs.
2. `2026-08-26-cloud-canvases-assets.md`
   - Depends on Plan 1. Adds revisioned cloud canvases, S3 upload intents, Asset metadata, and frontend repositories.
3. `2026-08-26-workspace-billing-ledger.md`
   - Depends on Plan 1 and may execute in parallel with Plan 2. Adds balanced ledger transactions, Wallet projections, per-order Hold, registration grants, and admin adjustments.
4. `2026-08-26-ai-task-provider-platform.md`
   - Depends on Plans 2 and 3. Adds model catalog, durable AI Tasks, pg-boss Worker, OpenAI-compatible image adapter, output storage, SSE, and reconciliation.
5. `2026-08-26-frontend-cutover-deployment.md`
   - Depends on Plans 1–4. Replaces browser-direct platform calls, adds user/admin flows, production containers, observability, and release acceptance.

## Stable Cross-Plan Interfaces

```ts
export type RequestContext = {
  requestId: string
  userId: string
}

export type WorkspaceAccess = {
  workspaceId: string
  userId: string
  role: 'owner' | 'admin' | 'member'
}

export async function requireSession(request: FastifyRequest): Promise<RequestContext>
export async function requireWorkspaceMember(request: FastifyRequest, workspaceId: string): Promise<WorkspaceAccess>
```

```ts
export type Transaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]

export async function reserveBillingOrder(
  tx: Transaction,
  input: ReserveBillingOrderInput,
): Promise<ReservedBillingOrder>

export async function settleBillingOrder(
  tx: Transaction,
  input: SettleBillingOrderInput,
): Promise<void>

export async function releaseBillingOrder(
  tx: Transaction,
  input: ReleaseBillingOrderInput,
): Promise<void>
```

```ts
export interface AssetStorage {
  createUploadIntent(input: CreateUploadIntentInput): Promise<UploadIntent>
  stat(objectKey: string): Promise<StoredObjectMetadata>
  copyRemoteOutput(input: CopyRemoteOutputInput): Promise<StoredObjectMetadata>
  createDownloadUrl(objectKey: string): Promise<string>
  delete(objectKey: string): Promise<void>
}
```

```ts
export interface ProviderAdapter {
  readonly key: string
  validate(route: ProviderRoute, input: GenerationInput): Promise<void>
  submit(context: SubmitContext): Promise<SubmitOutcome>
  poll?(context: PollContext): Promise<PollOutcome>
  cancel?(context: CancelContext): Promise<CancelOutcome>
  classifyError(error: unknown): ProviderFailure
}
```

## Delivery Gates

- Gate 1: A user can register, sign in, receive a personal Workspace, create a team Workspace, and switch Workspace without trusting client-supplied membership.
- Gate 2: A signed-in member can create, save, reload, and conflict-check a cloud canvas, then upload and retrieve a private Asset.
- Gate 3: Registration grants and admin adjustments produce balanced immutable entries; concurrent Hold requests cannot overspend.
- Gate 4: One OpenAI-compatible image route creates an atomic task/Hold/job, stores output as an Asset, settles points exactly once, and exposes replayable progress.
- Gate 5: Browser-direct platform keys and arbitrary scripts are absent from the user flow; production deployment, alerts, backup expectations, and manual acceptance are documented.

## Seven-Day Sequence

| Day | Plan focus | Required gate |
|---|---|---|
| 1 | Plan 1 tasks 1–3 | Fastify, PostgreSQL, Better Auth mounted |
| 2 | Plan 1 tasks 4–5 and Plan 2 tasks 1–2 | Workspace authorization and Canvas API |
| 3 | Plan 2 tasks 3–5 and Plan 3 tasks 1–2 | Cloud canvas/assets and balanced ledger |
| 4 | Plan 3 tasks 3–5 and Plan 4 task 1 | Hold lifecycle and AI domain schema |
| 5 | Plan 4 tasks 2–4 | One complete image generation path |
| 6 | Plan 4 tasks 5–6 and Plan 5 tasks 1–3 | SSE, recovery, frontend cutover |
| 7 | Plan 5 tasks 4–7 | Admin, deploy, monitoring, human acceptance |

If the schedule slips, retain image generation, billing correctness, idempotency, reconciliation, cloud canvases, and private Assets. Cut video adaptation and nonessential admin presentation before weakening transaction or recovery guarantees.

