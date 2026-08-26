# Workspace Billing Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement auditable Workspace points with immutable balanced postings, cached Wallet projections, per-order Hold, registration grants, and atomic admin adjustments.

**Architecture:** PostgreSQL row locks and constraints own correctness. Every operation appends a uniquely keyed balanced Ledger Transaction and updates Wallet projections in the same transaction; billing Hold belongs to exactly one Billing Order.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL transactions and deferred constraint triggers, Fastify, TypeBox, Vitest, Testcontainers.

**Spec:** `docs/superpowers/specs/2026-08-26-backend-platform-architecture-design.md`

## Global Constraints

- Depends on the completed identity/Workspace plan.
- Use `BIGINT` in PostgreSQL and JavaScript `bigint` internally; serialize point amounts as decimal strings in JSON.
- No float conversion, balance overwrite, mutable ledger history, or Redis lock is permitted.
- Admin operation, postings, Wallet projection, Hold transition, and audit record commit together.
- Duplicate `operationKey` returns the prior outcome only when its request hash matches; otherwise return `409 idempotency_conflict`.
- Write tests and provide commands without executing tests, typechecks, builds, or browser automation.

---

### Task 1: Billing Schema and Database Invariants

**Files:**
- Create: `packages/contracts/src/billing.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `server/src/modules/billing/schema.ts`
- Create: `server/src/modules/admin/schema.ts`
- Create: `server/migrations/0003_billing_ledger.sql`
- Create: `server/test/billing/schema.test.ts`
- Modify: `server/src/infrastructure/database/schema.ts`

**Interfaces:**
- Produces: tables `wallets`, `ledgerTransactions`, `ledgerPostings`, `billingOrders`, `walletHolds`, `auditLogs`, and `platformAdmins`.
- Produces: `PointAmountSchema = Type.String({ pattern: '^(0|[1-9][0-9]*)$' })`.

- [ ] **Step 1: Add database constraint tests**

```ts
it('rejects negative wallet projections', async () => {
  await expect(db.insert(wallets).values({ workspaceId, availableAmount: -1n, heldAmount: 0n }))
    .rejects.toThrow()
})

it('rejects an unbalanced ledger transaction at commit', async () => {
  await expect(db.transaction(async (tx) => {
    const [entry] = await tx.insert(ledgerTransactions).values(transactionFixture()).returning()
    await tx.insert(ledgerPostings).values({ transactionId: entry.id, accountType: 'workspace_available', walletId, amount: 10n })
  })).rejects.toThrow('ledger transaction is not balanced')
})
```

- [ ] **Step 2: Define tables and row constraints**

Wallet checks require available and held amounts greater than or equal to zero. Hold checks require all amounts non-negative, captured plus released no greater than original, and a unique Billing Order. Billing Order is unique per Task ID and stores immutable `pricing_snapshot_json`.

- [ ] **Step 3: Add deferred balance enforcement**

Create PostgreSQL deferred constraint triggers on both Ledger Transaction insertion and Posting changes. At transaction commit they raise when the affected transaction has no postings or `sum(ledger_postings.amount) <> 0`. Add a trigger rejecting UPDATE and DELETE on committed Ledger Transactions and Postings; corrections use new compensation entries.

- [ ] **Step 4: Add external point contracts**

All API responses expose `availableAmount`, `heldAmount`, `estimatedAmount`, and `actualAmount` as decimal strings. Parsing functions reject signs, decimals, exponent notation, whitespace, and values greater than the configured platform maximum.

- [ ] **Step 5: Hand verification to the user**

```bash
bun --cwd server run test -- test/billing/schema.test.ts
```

Expected: negative projections, over-captured Hold, mutable history, and unbalanced postings are rejected by PostgreSQL.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src server/src/modules/billing server/migrations server/test/billing server/src/infrastructure/database
git commit -m "feat: add immutable points ledger schema"
```

### Task 2: Balanced Ledger and Wallet Service

**Files:**
- Create: `server/src/modules/billing/ledger.ts`
- Create: `server/src/modules/billing/wallets.ts`
- Create: `server/src/modules/billing/types.ts`
- Create: `server/test/billing/ledger.test.ts`

**Interfaces:**
- Produces: `getOrCreateWorkspaceWallet(tx, workspaceId)`.
- Produces: `appendBalancedTransaction(tx, input): Promise<LedgerTransactionResult>`.
- Produces: `grantPoints(tx, input)` and `adjustPoints(tx, input)`.

- [ ] **Step 1: Add grant, duplicate, and concurrent debit tests**

```ts
it('grants points with a balanced system offset', async () => {
  await db.transaction((tx) => grantPoints(tx, { workspaceId, amount: 100n, operationKey: 'grant:1', actor: systemActor }))
  expect(await walletBalance(db, workspaceId)).toEqual({ available: 100n, held: 0n })
  expect(await postingSum(db, 'grant:1')).toBe(0n)
})

it('returns one result for duplicate matching operation keys', async () => {
  const results = await Promise.allSettled([1, 2].map(() => db.transaction((tx) =>
    grantPoints(tx, { workspaceId, amount: 100n, operationKey: 'grant:duplicate', actor: systemActor }))))
  expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(2)
  expect(await transactionCount(db, 'grant:duplicate')).toBe(1)
})
```

- [ ] **Step 2: Implement Wallet locking**

`getOrCreateWorkspaceWallet` inserts on conflict do nothing, then selects the Wallet row `FOR UPDATE`. Every projection change goes through a locked Wallet row and one Ledger Transaction.

- [ ] **Step 3: Implement balanced append**

```ts
export async function appendBalancedTransaction(tx: Transaction, input: AppendLedgerInput) {
  const total = input.postings.reduce((sum, posting) => sum + posting.amount, 0n)
  if (total !== 0n) throw new Error('Ledger postings must balance')
  const [entry] = await tx.insert(ledgerTransactions)
    .values({ ...input.transaction, operationKey: input.operationKey, requestHash: input.requestHash })
    .onConflictDoNothing({ target: ledgerTransactions.operationKey })
    .returning()
  if (!entry) return assertMatchingReplay(await requireOperation(tx, input.operationKey), input.requestHash)
  await tx.insert(ledgerPostings).values(input.postings.map((posting) => ({ ...posting, transactionId: entry.id })))
  return { transactionId: entry.id, replayed: false }
}
```

- [ ] **Step 4: Implement grant and admin adjustment postings**

Positive grant posts `workspace_available +amount` and `system_issuance -amount`. Positive admin adjustment uses `system_adjustment`; negative adjustment locks the Wallet and rejects an amount greater than available.

- [ ] **Step 5: Hand verification to the user**

```bash
bun --cwd server run test -- test/billing/ledger.test.ts
```

Expected: replay is idempotent, request-hash mismatch returns conflict, balanced totals remain zero, and concurrent debits cannot create a negative Wallet.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/billing server/test/billing
git commit -m "feat: add transactional wallet ledger"
```

### Task 3: Billing Order and Per-Order Hold Lifecycle

**Files:**
- Create: `server/src/modules/billing/orders.ts`
- Create: `server/test/billing/orders.test.ts`

**Interfaces:**
- Produces: `reserveBillingOrder(tx, input): Promise<ReservedBillingOrder>`.
- Produces: `settleBillingOrder(tx, input): Promise<void>`.
- Produces: `releaseBillingOrder(tx, input): Promise<void>`.

- [ ] **Step 1: Add Hold isolation and terminalization tests**

```ts
it('settles only the Hold belonging to its order', async () => {
  const first = await reserve(orderInput({ taskId: task1, amount: 30n }))
  const second = await reserve(orderInput({ taskId: task2, amount: 40n }))
  await settle(first.orderId, 25n)
  expect(await holdAmounts(first.orderId)).toEqual({ captured: 25n, released: 5n })
  expect(await holdAmounts(second.orderId)).toEqual({ captured: 0n, released: 0n })
})

it('terminalizes an order exactly once under concurrent workers', async () => {
  const results = await Promise.allSettled([settle(orderId, 25n), settle(orderId, 25n)])
  expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(2)
  expect(await settlementCount(orderId)).toBe(1)
})
```

- [ ] **Step 2: Implement reserve**

Lock Wallet, verify status active and sufficient available points, create Billing Order and Hold, decrement available, increment held, append `hold` postings, and return IDs plus price snapshot. A Task ID can own only one order.

- [ ] **Step 3: Implement settle**

Lock Billing Order, Hold, and Wallet. If already settled with the same operation key, return the prior result. Require `actualAmount <= originalAmount`, decrement held by original, increment available by unused amount, post captured amount to `system_consumed`, close Hold, and set order settled.

- [ ] **Step 4: Implement release**

Lock the same rows, decrement held by original, restore original to available, append release postings, close Hold, and set order released. Reject settle after release and release after settle with `409 billing_order_terminal` unless replaying the same operation.

- [ ] **Step 5: Hand verification to the user**

```bash
bun --cwd server run test -- test/billing/orders.test.ts
```

Expected: separate Holds never interfere, insufficient points fail before order creation, and concurrent terminalization emits one financial effect.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/billing/orders.ts server/test/billing/orders.test.ts
git commit -m "feat: add per-order points holds"
```

### Task 4: Registration Grant and Admin Adjustments

**Files:**
- Create: `server/src/modules/billing/grants.ts`
- Create: `server/src/modules/admin/billing-routes.ts`
- Create: `server/src/modules/admin/authorization.ts`
- Create: `server/test/billing/grants.test.ts`
- Create: `server/test/admin/billing.test.ts`
- Modify: `server/src/modules/identity/auth.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/config.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `grantVerifiedSignupPoints(db, userId): Promise<void>`.
- Produces: admin routes for adjustment, freeze, and unfreeze.

- [ ] **Step 1: Add verified-only and repeated-callback tests**

```ts
it('does not grant before email verification', async () => {
  await grantVerifiedSignupPoints(db, unverifiedUser.id)
  expect(await walletBalance(db, personalWorkspace.id)).toEqual({ available: 0n, held: 0n })
})

it('grants once after repeated verification callbacks', async () => {
  await Promise.all([grantVerifiedSignupPoints(db, user.id), grantVerifiedSignupPoints(db, user.id)])
  expect(await walletBalance(db, personalWorkspace.id)).toEqual({ available: 1000n, held: 0n })
  expect(await transactionCount(db, `signup-grant:${user.id}`)).toBe(1)
})
```

- [ ] **Step 2: Implement signup grant**

Read `SIGNUP_GRANT_POINTS` as a non-negative bigint string. Verify the user email timestamp, locate the personal Workspace, and call `grantPoints` with operation key `signup-grant:<userId>` in one transaction.

- [ ] **Step 3: Implement platform-admin authorization**

Store platform admin user IDs in the dedicated `platform_admins` table created by the billing migration, and seed the first admin from `BOOTSTRAP_ADMIN_EMAIL` in an idempotent release command. Do not infer platform admin from team Workspace roles. `requirePlatformAdmin` loads the authenticated user and checks the authoritative table.

- [ ] **Step 4: Implement atomic admin routes**

Adjustment accepts signed decimal-string amount, reason, and `Idempotency-Key`. Freeze/unfreeze update Wallet status and insert an Audit Log in the same transaction. Responses contain resulting decimal-string balances and transaction ID.

- [ ] **Step 5: Hand verification to the user**

```bash
bun --cwd server run test -- test/billing/grants.test.ts test/admin/billing.test.ts
```

Expected: unverified accounts receive nothing, duplicate verification grants once, non-admin calls return 403, and failed audit insertion rolls back the adjustment.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/billing server/src/modules/admin server/src/modules/identity/auth.ts server/src/config.ts .env.example server/src/app.ts server/test
git commit -m "feat: add signup grants and admin points controls"
```

### Task 5: Wallet APIs and Invariant Monitor

**Files:**
- Create: `server/src/modules/billing/routes.ts`
- Create: `server/src/modules/billing/invariants.ts`
- Create: `server/test/billing/routes.test.ts`
- Create: `server/test/billing/invariants.test.ts`
- Modify: `server/src/app.ts`

**Interfaces:**
- Produces: `GET /api/v1/workspaces/:workspaceId/wallet`.
- Produces: cursor-paginated `GET /api/v1/workspaces/:workspaceId/ledger-transactions`.
- Produces: `checkBillingInvariants(db): Promise<BillingInvariantReport>`.

- [ ] **Step 1: Add authorization and pagination tests**

```ts
it('returns decimal-string balances to a member', async () => {
  const response = await authenticatedInject(app, user, { method: 'GET', url: `/api/v1/workspaces/${workspace.id}/wallet` })
  expect(response.json()).toMatchObject({ availableAmount: '1000', heldAmount: '0', status: 'active' })
})

it('does not expose another workspace ledger', async () => {
  const response = await authenticatedInject(app, otherUser, { method: 'GET', url: `/api/v1/workspaces/${workspace.id}/ledger-transactions` })
  expect(response.statusCode).toBe(403)
})
```

- [ ] **Step 2: Add Wallet and Ledger routes**

Owner and admin may read the full Ledger. Member receives 403 for Ledger history in MVP but may read current Wallet balance. Cursor is `(createdAt,id)` and page size is bounded to 100.

- [ ] **Step 3: Implement invariant checks**

Report negative Wallets, unbalanced transactions, Wallet held projection differing from active Hold remainder, closed Holds whose captured plus released differs from original, and terminal Tasks with nonterminal Billing Orders. Return IDs and counts, never mutate data.

- [ ] **Step 4: Hand verification to the user**

```bash
bun --cwd server run test -- test/billing/routes.test.ts test/billing/invariants.test.ts
```

Expected: roles are enforced, pagination is stable, and seeded corruption is detected by each invariant query.

- [ ] **Step 5: Commit and update progress docs**

```bash
git add server/src/modules/billing server/test/billing server/src/app.ts CHANGELOG.md docs/content/docs/progress
git commit -m "feat: expose audited workspace points"
```
