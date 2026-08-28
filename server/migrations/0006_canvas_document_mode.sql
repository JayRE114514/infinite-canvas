ALTER TABLE "canvases" ADD COLUMN "document_mode" text DEFAULT 'snapshot' NOT NULL;
--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "deletion_receipt_id" uuid;
--> statement-breakpoint
ALTER TABLE "canvases" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $backfill$
DECLARE expected_count bigint; affected_count bigint; incoherent_count bigint;
BEGIN
    SELECT count(*) INTO expected_count
    FROM public.canvases WHERE deleted_at IS NOT NULL AND deletion_receipt_id IS NULL;
    UPDATE public.canvases SET deletion_receipt_id = gen_random_uuid()
    WHERE deleted_at IS NOT NULL AND deletion_receipt_id IS NULL;
    GET DIAGNOSTICS affected_count = ROW_COUNT;
    IF affected_count <> expected_count THEN RAISE EXCEPTION 'canvas receipt backfill count mismatch'; END IF;
    SELECT count(*) INTO incoherent_count
    FROM public.canvases WHERE (deleted_at IS NULL) <> (deletion_receipt_id IS NULL);
    IF incoherent_count <> 0 THEN RAISE EXCEPTION 'canvas deletion state incoherent after backfill'; END IF;
END
$backfill$;
--> statement-breakpoint
ALTER TABLE "canvases" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_document_mode_check" CHECK (document_mode IN ('snapshot', 'collaborative'));
--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_deletion_state_check" CHECK ((deleted_at IS NULL) = (deletion_receipt_id IS NULL));
--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_deletion_receipt_unique" UNIQUE("deletion_receipt_id");
--> statement-breakpoint
-- 回执的签发与不可变性是数据库不变量，不依赖服务层调用约定。
-- 唯一允许的删除跃迁是 deleted_at NULL -> NOT NULL，此时由触发器生成回执。
-- 签发之后，deleted_at 与 deletion_receipt_id 都不可再被修改或清空，杜绝复活与回执改写。
CREATE FUNCTION public.enforce_canvas_deletion_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $enforce_receipt$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.deleted_at IS NOT NULL OR NEW.deletion_receipt_id IS NOT NULL THEN
            RAISE EXCEPTION 'canvas deletion lifecycle cannot be supplied on insert'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.deleted_at IS NULL THEN
        IF NEW.deleted_at IS NOT NULL THEN
            -- 首次软删除：回执只能由触发器生成，调用方提供的值一律忽略。
            NEW.deletion_receipt_id := gen_random_uuid();
        ELSE
            -- 活跃画布的普通保存：不得凭空出现回执。
            NEW.deletion_receipt_id := NULL;
        END IF;
        RETURN NEW;
    END IF;

    -- 已签发：删除时间与回执都必须逐字节保持不变。
    IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
        RAISE EXCEPTION 'canvas deletion timestamp is immutable once issued'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.deletion_receipt_id IS DISTINCT FROM OLD.deletion_receipt_id THEN
        RAISE EXCEPTION 'canvas deletion receipt is immutable once issued'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END
$enforce_receipt$;
--> statement-breakpoint
ALTER FUNCTION public.enforce_canvas_deletion_receipt() OWNER TO schema_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.enforce_canvas_deletion_receipt() FROM PUBLIC, app_api, app_worker, app_maintenance;
--> statement-breakpoint
CREATE TRIGGER canvases_enforce_deletion_receipt
BEFORE INSERT OR UPDATE ON public.canvases
FOR EACH ROW
EXECUTE FUNCTION public.enforce_canvas_deletion_receipt();
