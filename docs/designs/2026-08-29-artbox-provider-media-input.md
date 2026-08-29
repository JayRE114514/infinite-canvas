# ArtBox Provider Media Input Design

## Status

Implementation candidate on `feat/provider-media-input`. The Asset/COS boundary, fixed ArtBox adapter, Canvas hosted branch, and deployment contract are present. Focused automated checks cover configuration and route registration; live Tencent COS/ArtBox, authenticated PostgreSQL-backed flow, and an external production Nginx deployment still require operator verification before production acceptance. The repository's tracked Docker, Render, and Vercel paths remain static-frontend-only and are not this deployment topology. Production requires a later integration with the API/PostgreSQL/Nginx deployment candidate on `origin/codex/tencent-deploy`, including injection of this feature's COS and ArtBox variables into its API service.

## Outcome

The hosted canvas can submit an ArtBox video generation with image, video, and audio references while the browser sends only stable `assetId` bindings. Tencent COS owns durable media bytes, ArtBox credentials stay on the server, and the existing same-origin `/api` reverse proxy remains the only browser API boundary.

This slice is intentionally an **unbilled owner-operated integration**. It does not use the canonical `/ai/tasks` aggregate because that contract requires Credit Hold, Billing Order, Ledger settlement, Worker leases, and Task Events in one closed workflow. Those modules and `WORKSPACE_ADMIN_PURPOSES` remain unchanged. The integration keeps a local ArtBox generation record so tenancy, idempotency, and ambiguous submissions remain safe; a later migration can move execution behind the canonical Worker without changing the canvas request contract.

## Invariants

- Browser requests and cloud canvas snapshots contain `assetId`, never Provider URLs, COS object keys, local paths, `storageKey`, `blob:` URLs, base64 media, API keys, or executable adapter configuration.
- ArtBox-specific field names and `@图片N` / `@视频N` / `@音频N` rewriting exist only in the owner-maintained server adapter.
- Only same-Workspace `ready` Assets of the declared kind can be sent to a Provider.
- Signed COS URLs are short-lived transport capabilities. They are generated immediately before an upstream request and are never persisted or logged.
- Provider network calls and COS network calls never run inside a PostgreSQL transaction.
- A successful ArtBox result is copied into a `ready` video Asset before the local generation becomes `succeeded`.
- An ambiguous create response never triggers an automatic second upstream submission.
- The change does not modify credits, ledger, billing, platform-admin purpose values, or another worktree.

## Public Contracts

### Asset

```ts
type AssetKind = "image" | "video" | "audio";
type AssetStatus = "staging" | "ready" | "failed" | "deleted";

type Asset = {
  id: string;
  workspaceId: string;
  kind: AssetKind;
  status: AssetStatus;
  fileName: string;
  contentType: string;
  byteSize: number | null;
  createdAt: string;
  updatedAt: string;
};
```

The browser creates a staging Asset, uploads bytes to a presigned staging key, then completes the upload. Completion HEAD-checks the staged object, copies it to a distinct immutable final key, verifies the final object, deletes the staging object, and advances the database row to `ready`. An upload capability can therefore never overwrite the final object after completion.

Routes:

```text
POST /api/v1/workspaces/:workspaceId/assets
POST /api/v1/workspaces/:workspaceId/assets/:assetId/complete
GET  /api/v1/workspaces/:workspaceId/assets/:assetId
```

The create response includes a presigned PUT URL and required headers. The read response includes a fresh signed GET URL only for UI playback/preview; callers must not persist it.

### Provider-neutral video request

```ts
type HostedMediaBinding = {
  nodeId: string;
  kind: "image" | "video" | "audio";
  assetId: string;
};

type CreateArtBoxVideoGeneration = {
  model: string;
  promptTemplate: string; // keeps @[node:<id>] tokens
  bindings: HostedMediaBinding[];
  seconds: string;
  aspectRatio?: string;
  resolution?: string;
  generateAudio: boolean;
};
```

Routes:

```text
POST /api/v1/workspaces/:workspaceId/integrations/artbox/video-generations
POST /api/v1/workspaces/:workspaceId/integrations/artbox/video-generations/:generationId/poll
```

Creation requires `Idempotency-Key`. The public generation ID is local; the ArtBox task ID remains server-side. The request schema is closed and rejects URL arrays and arbitrary extra Provider fields.

## ArtBox Mapping

The adapter resolves bindings in their supplied order. Each media kind has an independent one-based sequence. It replaces all matching `@[node:<id>]` tokens with `@图片N`, `@视频N`, or `@音频N`, and emits the corresponding signed URLs in `image_urls`, `video_urls`, and `audio_urls`. It never truncates reference arrays.

The upstream request is:

```json
{
  "model": "Artdance 2 Mini-480p",
  "prompt": "参考 @图片1 的人物、@视频1 的运镜和 @音频1 的节奏",
  "seconds": "5",
  "image_urls": ["<ephemeral signed COS URL>"],
  "video_urls": ["<ephemeral signed COS URL>"],
  "audio_urls": ["<ephemeral signed COS URL>"],
  "generate_audio": true
}
```

Create accepts `task_id` from either the top-level response or `data`. Poll normalizes queued/pending, processing/running, completed/succeeded, and terminal failure variants. Unknown statuses, a successful response without a URL, and ambiguous create failures enter `reconciling` rather than being guessed.

## Persistence and Security

`assets` is Workspace-scoped and RLS-forced. It stores the immutable final object key and a transient staging key, but neither key is exposed after creation. `artbox_video_generations` is also Workspace-scoped and RLS-forced. It stores normalized input with Asset IDs, request hash, local status, remote task ID, result Asset ID, and a public sanitized error. It never stores a signed URL or Authorization header.

`(workspace_id, idempotency_key)` is unique. Same key plus same canonical request returns the existing local generation; same key plus a different hash returns `409 idempotency_conflict`. A generation with a known remote task ID is only polled and is never submitted again.

The object-store and Provider boundaries are injected interfaces so unit tests use deterministic fakes. Production uses `cos-nodejs-sdk-v5` and native `fetch`. ArtBox result downloads require HTTPS, an explicitly configured host allowlist, a configured request timeout, and a configured maximum response size. These values have no source-code defaults; deployment must choose them explicitly.

## Canvas Integration

The existing Composer graph traversal remains authoritative for token order and reference discovery. A hosted request builder converts those references into typed bindings and calls `ensureAssetReady` for every image, video, and audio input. Existing `assetId` values are reused; otherwise local IndexedDB bytes are uploaded once and the node is updated with the returned ID. Missing local bytes fail explicitly and never fall back to a URL.

The ArtBox model is an explicit hosted capability. Local/custom channels keep the existing browser-direct path. Selecting the hosted ArtBox capability bypasses browser API key/base URL/plugin configuration, submits the provider-neutral request through the same-origin API, polls the local generation, then hydrates the returned result Asset into the target video node.

For Asset-backed nodes, cloud snapshots preserve `assetId` and non-location metadata while omitting transient playback URLs and local storage keys. Opening a canvas requests a fresh display URL from the Asset API. Legacy local nodes remain usable in local mode and are uploaded lazily the first time they participate in a hosted request.

## Configuration

The server accepts an all-or-none COS block and an all-or-none ArtBox block. Secrets remain only in server environment variables.

```text
COS_SECRET_ID
COS_SECRET_KEY
COS_BUCKET
COS_REGION
COS_SIGNED_URL_TTL_SECONDS

ARTBOX_BASE_URL=<confirmed HTTPS API origin>
ARTBOX_API_KEY
ARTBOX_VIDEO_MODELS=Artdance 2 Mini-480p
ARTBOX_REQUEST_TIMEOUT_MS
ARTBOX_RESULT_MAX_BYTES
ARTBOX_RESULT_ALLOWED_HOSTS
ARTBOX_POLL_LEASE_SECONDS
```

Partial configuration fails startup. Production requires HTTPS ArtBox base and result URLs. No timeout, TTL, lease, or maximum-size fallback is invented by the application.

## Failure Semantics

- Missing Provider or COS configuration: `503 provider_configuration_error` / `asset_storage_configuration_error`.
- Cross-Workspace or missing Asset: `404 asset_not_found` without existence leakage.
- Asset kind mismatch: `422 asset_kind_mismatch`.
- Non-ready Asset: `409 asset_not_ready`.
- ArtBox authentication failure: generation fails with a sanitized Provider configuration error, never user `401`.
- Provider create timeout, 5xx, or missing task ID: `reconciling`; no blind resubmit.
- Provider poll outage or rate limit: generation remains non-terminal and returns a retryable public error.
- Result download or COS write failure: generation never becomes `succeeded`.

## Deliberate Deferrals

- Canonical AI Task, Provider Attempt, Task Event, pg-boss Worker, SSE, cancellation, credits, billing, ledger, and admin reconciliation.
- General model marketplace or user-supplied Provider adapters.
- Asset list/delete UI and bulk migration of old local media.
- Background polling. The canvas explicitly polls the local integration endpoint; all intervals remain at the existing UI polling boundary.

This exception is removable: the browser contract already contains only capability data and Asset IDs, so a future canonical Task route can consume the same request without Provider knowledge leaking into the canvas.
