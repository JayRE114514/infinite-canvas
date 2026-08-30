import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createAuthTestHarness, registerVerifiedUser } from "../helpers/auth.js";

const harness = createAuthTestHarness();

beforeAll(async () => {
    await harness.start();
}, 180_000);

afterEach(async () => {
    await harness.cleanup();
}, 30_000);

afterAll(async () => {
    await harness.stop();
}, 60_000);

describe("admin Workspace credit grant", () => {
    it("commits one balanced adjustment and audit, replays the same request, and exposes the exact balance to a member", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, {
            name: "积分空间所有者",
            email: `credit-owner-${randomUUID()}@example.com`,
        });
        const platformAdmin = await registerVerifiedUser(app, mailer, {
            name: "积分管理员",
            email: `credit-admin-${randomUUID()}@example.com`,
        });
        await adminPool.query("insert into public.platform_admins (user_id, status) values ($1, 'active')", [
            platformAdmin.userId,
        ]);

        const listed = await app.inject({ method: "GET", url: "/api/v1/workspaces", headers: { cookie: owner.cookie } });
        const workspaceId = listed.json().workspaces[0].id as string;
        const url = `/api/v1/admin/workspaces/${workspaceId}/credits/grant`;
        const headers = { cookie: platformAdmin.cookie, "idempotency-key": "grant-safe-integer-boundary" };
        const payload = { amount: "9007199254740992", reason: "首轮平台赠送" };

        const granted = await app.inject({ method: "POST", url, headers, payload });
        const replayed = await app.inject({ method: "POST", url, headers, payload });
        const conflict = await app.inject({ method: "POST", url, headers, payload: { ...payload, amount: "1" } });
        const balance = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspaceId}/credits/balance`,
            headers: { cookie: owner.cookie },
        });

        expect(granted.statusCode, granted.body).toBe(200);
        expect(granted.json()).toMatchObject({
            replayed: false,
            balance: { workspaceId, available: payload.amount, held: "0" },
        });
        expect(replayed.statusCode, replayed.body).toBe(200);
        expect(replayed.json()).toEqual({ ...granted.json(), replayed: true });
        expect(conflict.statusCode, conflict.body).toBe(409);
        expect(conflict.json().error.code).toBe("idempotency_conflict");
        expect(balance.statusCode, balance.body).toBe(200);
        expect(balance.json().balance).toEqual({ workspaceId, available: payload.amount, held: "0" });

        const stored = await adminPool.query(
            `select
                (select count(*)::int from public.credit_transactions where workspace_id = $1) as transactions,
                (select count(*)::int from public.ledger_entries where workspace_id = $1) as entries,
                (select sum(amount)::text from public.ledger_entries where workspace_id = $1) as entry_sum,
                (select count(*)::int from public.workspace_audit_logs where workspace_id = $1 and action = 'wallet_adjust') as audits,
                (select count(*)::int from public.admin_operations where target_workspace_id = $1 and purpose = 'wallet_adjust') as operations`,
            [workspaceId],
        );
        const auditBindings = await adminPool.query(
            `select a.credit_amount::text as amount, a.credit_reason as reason, a.replayed,
                    a.credit_transaction_id as transaction_id,
                    (a.transaction_xid = o.transaction_xid) as same_xid,
                    (a.actor_user_id = o.admin_user_id) as same_actor
             from public.workspace_audit_logs a
             join public.admin_operations o on o.id = a.operation_id
             where a.workspace_id = $1 and a.action = 'wallet_adjust'
             order by a.created_at`,
            [workspaceId],
        );

        expect(stored.rows).toEqual([{ transactions: 1, entries: 2, entry_sum: "0", audits: 2, operations: 2 }]);
        expect(auditBindings.rows).toEqual([
            { amount: payload.amount, reason: payload.reason, replayed: false, transaction_id: granted.json().transactionId, same_xid: true, same_actor: true },
            { amount: payload.amount, reason: payload.reason, replayed: true, transaction_id: granted.json().transactionId, same_xid: true, same_actor: true },
        ]);
    }, 90_000);
});
