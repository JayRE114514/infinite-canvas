-- Worker 只在 withWorkerTransaction 已建立的 Workspace 上下文中读取结算事实。
GRANT SELECT ON public.billing_orders, public.credit_holds TO app_worker;
--> statement-breakpoint
CREATE POLICY billing_orders_worker_workspace ON public.billing_orders
FOR SELECT TO app_worker
USING (workspace_id = nullif(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY credit_holds_worker_workspace ON public.credit_holds
FOR SELECT TO app_worker
USING (workspace_id = nullif(current_setting('app.workspace_id', true), ''));
