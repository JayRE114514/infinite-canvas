# Backend Foundation, Identity, and Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-shaped Fastify server with PostgreSQL, Better Auth, personal/team Workspaces, and a frontend authenticated Workspace shell.

**Architecture:** Convert the web/server/contracts slice into a Bun workspace while leaving docs and canvas-agent independent. Better Auth owns authentication records and its Organization tables are mapped to Workspace tables; application guards remain the only authorization entry point for business routes.

**Tech Stack:** Bun 1.3.13, Node.js 24 LTS, Fastify 5, TypeBox, Better Auth Organization plugin, Drizzle ORM with node-postgres, PostgreSQL, Vitest, Testcontainers, React 19, TanStack Query, Zustand.

**Spec:** `docs/superpowers/specs/2026-08-26-backend-platform-architecture-design.md`

## Global Constraints

- Use the global constraints in `docs/superpowers/plans/2026-08-26-backend-platform-roadmap.md`.
- Configure production CORS as same-origin; allow only the explicit Vite origin in development.
- Better Auth tables use plural business names, but other modules never import Better Auth internals directly.
- A personal Workspace has exactly one owner and cannot accept invitations.
- All business authorization rechecks the database membership for the path `workspaceId`.
- Write tests and provide commands without executing tests, typechecks, builds, or browser automation.

---

### Task 1: Bun Workspace and Fastify Health Contract

**Files:**
- Create: `package.json`
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/vitest.config.ts`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/health.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `server/src/app.ts`
- Create: `server/src/api.ts`
- Create: `server/src/errors.ts`
- Create: `server/src/error-handler.ts`
- Create: `server/src/infrastructure/idempotency.ts`
- Create: `server/test/health.test.ts`
- Create: `server/test/errors.test.ts`
- Create: `server/test/idempotency.test.ts`
- Modify: `web/package.json`
- Modify: `web/vite.config.ts`
- Modify: `Dockerfile`
- Remove after root install: `web/bun.lock`
- Generate: `bun.lock`

**Interfaces:**
- Produces: `buildApp(options?: BuildAppOptions): Promise<FastifyInstance>`.
- Produces: `HealthResponseSchema` and `HealthResponse` from `@infinite-canvas/contracts`.
- Produces: `AppError(code, statusCode, publicMessage, retryable?)` and the stable `{ error }` response envelope.
- Produces: `hashCanonicalRequest(value: unknown): string` for all idempotency request hashes.

- [ ] **Step 1: Add the failing Fastify inject test**

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

describe('health routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined

  afterEach(async () => app?.close())

  it('returns a stable liveness response', async () => {
    app = await buildApp({ logger: false })
    const response = await app.inject({ method: 'GET', url: '/api/v1/health/live' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })
})
```

- [ ] **Step 2: Create the root workspace and dependency manifests**

```json
{
  "name": "infinite-canvas-platform",
  "private": true,
  "packageManager": "bun@1.3.13",
  "workspaces": ["web", "server", "packages/*"],
  "scripts": {
    "dev:web": "bun --cwd web dev",
    "dev:api": "bun --cwd server dev:api",
    "dev:worker": "bun --cwd server dev:worker",
    "test:server": "bun --cwd server run test"
  }
}
```

`server/package.json` must expose `dev:api`, `dev:worker`, `test`, `typecheck`, `db:generate`, and `db:migrate`. Runtime dependencies are `fastify`, `@fastify/cors`, `@fastify/swagger`, `@fastify/type-provider-typebox`, `typebox`, `better-auth`, `drizzle-orm`, `pg`, `pg-boss`, `nodemailer`, `json-canonicalize`, and `@infinite-canvas/contracts`; development dependencies are `typescript`, `tsx`, `vitest`, `testcontainers`, `drizzle-kit`, `@types/node`, `@types/pg`, and `@types/nodemailer`.

- [ ] **Step 3: Add the shared health schema and minimal app**

```ts
// packages/contracts/src/health.ts
import { Type, type Static } from 'typebox'

export const HealthResponseSchema = Type.Object({ status: Type.Literal('ok') })
export type HealthResponse = Static<typeof HealthResponseSchema>
```

```ts
// server/src/app.ts
import Fastify, { type FastifyServerOptions } from 'fastify'
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { HealthResponseSchema } from '@infinite-canvas/contracts'

export type BuildAppOptions = Pick<FastifyServerOptions, 'logger'>

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true }).withTypeProvider<TypeBoxTypeProvider>()
  app.get('/api/v1/health/live', {
    schema: { response: { 200: HealthResponseSchema } },
  }, async () => ({ status: 'ok' as const }))
  return app
}
```

Register one error handler that maps `AppError` to its public code/message, Fastify validation errors to `400 invalid_request`, and unknown errors to `500 internal_error`. Log unknown errors by request ID, but never return their stack or raw message.

Implement request hashing with the maintained `json-canonicalize` package and `node:crypto`, not a handwritten key sorter:

```ts
export function hashCanonicalRequest(value: unknown) {
  return createHash('sha256').update(canonicalize(value)).digest('hex')
}
```

- [ ] **Step 4: Add Vite development proxy and generate the root lockfile**

Add `/api` proxying to `http://127.0.0.1:4000` in `web/vite.config.ts`, add `@infinite-canvas/contracts` to `web/package.json`, then run `bun install` only to generate `bun.lock` and workspace links. Remove `web/bun.lock` after the root lock is generated. Update the existing static-web `Dockerfile` in the same commit to copy the root workspace manifests and `bun.lock` before building `bun --cwd web build`, so the current image remains buildable until the deployment plan splits the images.

- [ ] **Step 5: Hand verification to the user**

User runs:

```bash
bun --cwd server run test -- test/health.test.ts test/errors.test.ts test/idempotency.test.ts
```

Expected: one passing liveness test and no network listener opened by the test.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock web/package.json web/vite.config.ts web/bun.lock Dockerfile server packages/contracts
git commit -m "feat: add Fastify platform foundation"
```

### Task 2: Runtime Configuration and PostgreSQL Connection

**Files:**
- Create: `server/src/config.ts`
- Create: `server/src/infrastructure/database/client.ts`
- Create: `server/src/infrastructure/database/schema.ts`
- Create: `server/src/infrastructure/database/types.ts`
- Create: `server/src/infrastructure/database/plugin.ts`
- Create: `server/src/types/fastify.d.ts`
- Create: `server/drizzle.config.ts`
- Create: `server/test/config.test.ts`
- Create: `server/test/database/connection.test.ts`
- Create: `server/test/helpers/postgres.ts`
- Modify: `server/src/app.ts`
- Create: `.env.example`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): AppConfig`.
- Produces: `createDatabase(config: DatabaseConfig): { db: AppDatabase; pool: Pool }`.
- Produces: Fastify decorations `appConfig`, `db`, and `pgPool`.

- [ ] **Step 1: Add configuration validation tests**

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('rejects a missing database URL', () => {
    expect(() => loadConfig({
      NODE_ENV: 'test', BETTER_AUTH_SECRET: 'x'.repeat(32), APP_ORIGIN: 'http://localhost:3000',
      SMTP_HOST: 'localhost', SMTP_FROM: 'no-reply@example.com',
    }))
      .toThrow('DATABASE_URL')
  })

  it('parses bounded pool and server settings', () => {
    const config = loadConfig({
      NODE_ENV: 'test', DATABASE_URL: 'postgres://test:test@localhost/test',
      BETTER_AUTH_SECRET: 'x'.repeat(32), APP_ORIGIN: 'http://localhost:3000',
      PORT: '4100', DB_POOL_MAX: '8', SMTP_HOST: 'localhost', SMTP_PORT: '1025',
      SMTP_FROM: 'no-reply@example.com',
    })
    expect(config.port).toBe(4100)
    expect(config.database.poolMax).toBe(8)
  })
})
```

- [ ] **Step 2: Implement explicit environment parsing**

```ts
export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production'
  port: number
  appOrigin: string
  betterAuthSecret: string
  database: { url: string; poolMax: number }
  smtp: { host: string; port: number; user: string; password: string; from: string }
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const required = (name: string) => {
    const value = env[name]?.trim()
    if (!value) throw new Error(`Missing required environment variable: ${name}`)
    return value
  }
  const port = Number(env.PORT || 4000)
  const poolMax = Number(env.DB_POOL_MAX || 10)
  const smtpPort = Number(env.SMTP_PORT || 587)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1..65535')
  if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 50) throw new Error('DB_POOL_MAX must be 1..50')
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) throw new Error('SMTP_PORT must be 1..65535')
  return {
    nodeEnv: (env.NODE_ENV || 'development') as AppConfig['nodeEnv'],
    port,
    appOrigin: required('APP_ORIGIN'),
    betterAuthSecret: required('BETTER_AUTH_SECRET'),
    database: { url: required('DATABASE_URL'), poolMax },
    smtp: {
      host: required('SMTP_HOST'), port: smtpPort,
      user: env.SMTP_USER || '', password: env.SMTP_PASSWORD || '', from: required('SMTP_FROM'),
    },
  }
}
```

- [ ] **Step 3: Add the database factory and readiness route**

Use `pg.Pool` with `max`, `connectionTimeoutMillis: 5_000`, and `idleTimeoutMillis: 30_000`; create Drizzle with `drizzle(pool, { schema })`. `/api/v1/health/ready` executes `select 1` and returns `503` with `{ status: 'unavailable' }` when PostgreSQL is unreachable.

- [ ] **Step 4: Add the real PostgreSQL integration test**

```ts
it('executes a readiness query against PostgreSQL', async () => {
  const postgres = await startPostgres()
  const { pool } = createDatabase({ url: postgres.url, poolMax: 2 })
  await expect(pool.query('select 1 as ready')).resolves.toMatchObject({ rows: [{ ready: 1 }] })
  await pool.end()
  await postgres.stop()
})
```

- [ ] **Step 5: Hand verification to the user**

```bash
bun --cwd server run test -- test/config.test.ts test/database/connection.test.ts
```

Expected: configuration unit tests and PostgreSQL container integration test pass.

- [ ] **Step 6: Commit**

```bash
git add .env.example server
git commit -m "feat: add PostgreSQL runtime foundation"
```

### Task 3: Better Auth and Organization Schema

**Files:**
- Create: `server/src/modules/identity/auth-schema.ts`
- Create: `server/src/modules/identity/auth.ts`
- Create: `server/src/modules/identity/routes.ts`
- Create: `server/src/modules/identity/session.ts`
- Create: `server/src/modules/identity/types.ts`
- Create: `server/src/infrastructure/email/mailer.ts`
- Create: `server/test/identity/auth.test.ts`
- Generate: `server/migrations/0000_auth_and_workspaces.sql`
- Modify: `server/src/infrastructure/database/schema.ts`
- Modify: `server/src/app.ts`

**Interfaces:**
- Produces: `createAuth(deps: AuthDependencies): Auth`.
- Produces: `registerAuthRoutes(app, auth): Promise<void>`.
- Produces: `requireSession(request): Promise<RequestContext>`.

- [ ] **Step 1: Add unauthenticated-session and registration tests**

```ts
it('returns 401 from a protected probe without a session', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/v1/session-probe' })
  expect(response.statusCode).toBe(401)
  expect(response.json().error.code).toBe('unauthenticated')
})

it('creates an email/password user through Better Auth', async () => {
  const signUp = await app.inject({
    method: 'POST', url: '/api/auth/sign-up/email',
    payload: { name: '测试用户', email: 'user@example.com', password: 'correct-horse-battery-staple' },
  })
  expect(signUp.statusCode).toBe(200)
  expect(memoryMailer.messages).toHaveLength(1)
  const verificationUrl = new URL(memoryMailer.messages[0].verificationUrl)
  await app.inject({ method: 'GET', url: verificationUrl.pathname + verificationUrl.search })
  const signIn = await app.inject({
    method: 'POST', url: '/api/auth/sign-in/email',
    payload: { email: 'user@example.com', password: 'correct-horse-battery-staple' },
  })
  expect(signIn.headers['set-cookie']).toBeDefined()
})
```

- [ ] **Step 2: Configure Better Auth with mapped plural tables**

```ts
export function createAuth({ db, config }: AuthDependencies) {
  return betterAuth({
    basePath: '/api/auth',
    secret: config.betterAuthSecret,
    baseURL: config.appOrigin,
    trustedOrigins: [config.appOrigin],
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema, usePlural: true }),
    emailAndPassword: { enabled: true, requireEmailVerification: true },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: ({ user, url }) => mailer.sendVerification(user.email, url),
    },
    user: { modelName: 'users' },
    session: { modelName: 'sessions' },
    account: { modelName: 'accounts' },
    verification: { modelName: 'verifications' },
    plugins: [organization({
      allowUserToCreateOrganization: false,
      disableOrganizationDeletion: true,
      requireEmailVerificationOnInvitation: true,
      sendInvitationEmail: (data) => mailer.sendWorkspaceInvitation(data.email, data.invitation.id),
      schema: {
        organization: {
          modelName: 'workspaces',
          additionalFields: {
            workspaceType: { type: 'string', input: false, required: true, defaultValue: 'team' },
            status: { type: 'string', input: false, required: true, defaultValue: 'active' },
            ownerUserId: { type: 'string', input: false, required: true },
          },
        },
        member: { modelName: 'workspace_members' },
        invitation: { modelName: 'workspace_invitations' },
      },
      organizationHooks: {
        beforeCreateOrganization: async () => {
          throw new APIError('FORBIDDEN', {
            code: 'WORKSPACE_CREATION_REQUIRES_APPLICATION_ROUTE',
            message: 'Workspace creation requires the application route',
          })
        },
      },
    })],
  })
}
```

- [ ] **Step 3: Mount the official Fetch-compatible handler**

Use `fromNodeHeaders(request.headers)`, construct a standard `Request`, call `auth.handler(req)`, copy status and all response headers, and send the response text. Register only the exact identity routes required by the frontend: `POST /api/auth/sign-up/email`, `POST /api/auth/sign-in/email`, `GET /api/auth/get-session`, `POST /api/auth/sign-out`, `GET /api/auth/verify-email`, and `POST /api/auth/send-verification-email`. Do not mount any `/api/auth/organization/*` route.

- [ ] **Step 4: Implement the stable session guard**

```ts
export async function requireSession(request: FastifyRequest): Promise<RequestContext> {
  const session = await request.server.auth.api.getSession({ headers: fromNodeHeaders(request.headers) })
  if (!session) throw new AppError('unauthenticated', 401, '请先登录')
  return { requestId: request.id, userId: session.user.id }
}
```

- [ ] **Step 5: Generate and inspect the migration**

Run the Better Auth schema generator for PostgreSQL, map the generated tables to the file names above, then use Drizzle Kit to generate `0000_auth_and_workspaces.sql`. The migration must contain unique user email, unique Workspace slug, member user/Workspace foreign keys, invitation expiry, `workspace_type`, `status`, and `owner_user_id`. `SmtpMailer` uses Nodemailer with the validated SMTP config and exposes explicit verification and Workspace-invitation methods; identity tests inject a memory mailer and follow its captured verification URL.

- [ ] **Step 6: Hand verification to the user**

```bash
bun --cwd server run test -- test/identity/auth.test.ts
```

Expected: unauthenticated request is rejected, registration emits one verification email through the memory mailer, following that URL verifies the account, and sign-in then returns a session cookie.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/identity server/src/infrastructure/database server/migrations server/test/identity server/src/app.ts
git commit -m "feat: add Better Auth identity schema"
```

### Task 4: Personal and Team Workspace Domain

**Files:**
- Create: `packages/contracts/src/workspaces.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `server/src/modules/workspaces/service.ts`
- Create: `server/src/modules/workspaces/authorization.ts`
- Create: `server/src/modules/workspaces/routes.ts`
- Create: `server/test/workspaces/workspaces.test.ts`
- Modify: `server/src/app.ts`

**Interfaces:**
- Consumes: `requireSession(request)` from Task 3.
- Produces: `ensurePersonalWorkspace(db, user): Promise<WorkspaceSummary>`.
- Produces: `requireWorkspaceMember(request, workspaceId): Promise<WorkspaceAccess>`.

- [ ] **Step 1: Add idempotent personal Workspace and authorization tests**

```ts
it('creates exactly one personal workspace for repeated calls', async () => {
  const first = await ensurePersonalWorkspace(db, user)
  const second = await ensurePersonalWorkspace(db, user)
  expect(second.id).toBe(first.id)
  expect(await countPersonalWorkspaces(db, user.id)).toBe(1)
})

it('does not authorize membership from a client-selected workspace id', async () => {
  await expect(requireWorkspaceMember(requestFor(otherUser), workspace.id))
    .rejects.toMatchObject({ code: 'workspace_forbidden' })
})
```

- [ ] **Step 2: Implement personal Workspace creation in one transaction**

Use deterministic slug prefix `personal-<userId>`, insert `workspaces.workspaceType = 'personal'`, set `ownerUserId`, insert one owner member, and rely on a unique partial index over personal owner identity. On unique conflict, query and return the existing Workspace. `GET /api/v1/workspaces` calls this idempotent function after an authenticated verified user arrives, so a failed post-verification callback cannot leave the account permanently without a personal Workspace.

- [ ] **Step 3: Implement Workspace authorization**

```ts
export async function requireWorkspaceMember(request: FastifyRequest, workspaceId: string) {
  const { userId } = await requireSession(request)
  const member = await request.server.db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.organizationId, workspaceId), eq(workspaceMembers.userId, userId)),
  })
  if (!member) throw new AppError('workspace_forbidden', 403, '无权访问当前空间')
  return { workspaceId, userId, role: parseWorkspaceRole(member.role) }
}
```

- [ ] **Step 4: Add Workspace routes**

Implement `GET /api/v1/workspaces`, `POST /api/v1/workspaces`, `GET /api/v1/workspaces/:workspaceId`, `PATCH /api/v1/workspaces/:workspaceId`, member listing/removal, and invitation list/create/accept/cancel endpoints. Team creation inserts the Workspace and owner membership with application-generated IDs in one Drizzle transaction and never writes `activeOrganizationId`. Invitation acceptance conditionally claims the verified recipient's nonexpired pending invitation, locks the target Workspace row, checks capacity, inserts membership, and marks accepted in one transaction. Invitation generation and other safe operations may delegate to explicit Better Auth server APIs only after application path-membership and owner/admin checks. Reject invitation or member mutation when `workspaceType = 'personal'` with `409 personal_workspace_single_member`.

- [ ] **Step 5: Hand verification to the user**

```bash
bun --cwd server run test -- test/workspaces/workspaces.test.ts
```

Expected: personal creation is idempotent; team creation succeeds; cross-Workspace access and personal invitations fail.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src server/src/modules/workspaces server/test/workspaces server/src/app.ts
git commit -m "feat: add personal and team workspaces"
```

### Task 5: Frontend Authentication and Workspace Shell

**Files:**
- Create: `web/src/lib/auth-client.ts`
- Create: `web/src/services/api/platform-client.ts`
- Create: `web/src/stores/use-workspace-store.ts`
- Create: `web/src/pages/auth/login.tsx`
- Create: `web/src/pages/auth/register.tsx`
- Create: `web/src/components/layout/authenticated-shell.tsx`
- Create: `web/src/components/layout/workspace-switcher.tsx`
- Create: `web/src/components/layout/workspace-members-modal.tsx`
- Modify: `web/src/components/layout/app-top-nav.tsx`
- Modify: `web/src/layouts/user-layout.tsx`
- Modify: `web/src/router.tsx`
- Modify: `web/src/stores/use-user-store.ts`
- Modify: `web/src/i18n/locales/en-US.ts`
- Modify: `web/src/i18n/locales/zh-CN.ts`

**Interfaces:**
- Consumes: the exact Better Auth identity endpoints listed in Task 3 and typed Workspace business routes under `/api/v1`.
- Produces: `useWorkspaceStore` with `activeWorkspaceId`, `setActiveWorkspaceId`, and `clearWorkspace`.
- Produces: `platformRequest<T>(path, init): Promise<T>`.

- [ ] **Step 1: Add the typed platform client**

```ts
export async function platformRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init.headers },
  })
  if (!response.ok) throw await PlatformApiError.fromResponse(response)
  return response.json() as Promise<T>
}
```

- [ ] **Step 2: Create the Better Auth React client and pages**

Use `createAuthClient({ baseURL: window.location.origin })` from `better-auth/react`. Login calls `authClient.signIn.email`; registration calls `authClient.signUp.email`. Display server error codes through Chinese i18n messages without echoing raw response bodies.

- [ ] **Step 3: Add authenticated routing and Workspace selection**

`AuthenticatedShell` shows a loading state while `useSession` resolves, redirects anonymous users to `/login`, loads Workspaces through TanStack Query, and writes only `activeWorkspaceId` to sessionStorage so separate tabs may select different Workspaces. If the persisted ID is not in the returned list, select the personal Workspace.

- [ ] **Step 4: Replace the placeholder local user store**

Keep `useUserStore` as a small derived UI store only if non-React callers need it; synchronize it from Better Auth session and remove the fake `LocalUser` lifecycle. Signing out clears both user and active Workspace state.

- [ ] **Step 5: Give the user the manual acceptance checklist**

1. Register and verify an email.
2. Reload and confirm the cookie restores the session.
3. Confirm one personal Workspace exists.
4. Create a team Workspace, invite a verified second account, and confirm the second account can accept and access it.
5. Switch different tabs to different active Workspaces and confirm their selection remains independent.
6. Sign out and confirm protected pages redirect to `/login`.

- [ ] **Step 6: Commit and update progress docs**

```bash
git add web packages/contracts CHANGELOG.md docs/content/docs/progress
git commit -m "feat: add authenticated workspace shell"
```
