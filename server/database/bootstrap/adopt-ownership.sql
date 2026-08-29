-- 部署管理员动作：把上线前已存在的 public / drizzle 模式及其对象移交给 schema_owner。
-- 只处理目录里真实存在的对象，扩展自有对象保持原状；重复执行安全。
DO $adopt$
DECLARE
    target record;
BEGIN
    -- 先收回 PUBLIC 的建表权限，避免任何角色继续在业务模式里创建对象。
    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM PUBLIC';
    EXECUTE 'ALTER SCHEMA public OWNER TO schema_owner';

    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
        EXECUTE 'REVOKE CREATE ON SCHEMA drizzle FROM PUBLIC';
        EXECUTE 'ALTER SCHEMA drizzle OWNER TO schema_owner';
    END IF;

    -- 表 / 视图 / 序列等关系：按目录枚举并使用标识符安全引用。
    FOR target IN
        SELECT n.nspname AS schema_name,
               c.relname AS object_name,
               c.relkind AS object_kind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('public', 'drizzle')
          AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND NOT EXISTS (
              SELECT 1 FROM pg_depend d
              WHERE d.objid = c.oid AND d.deptype = 'e'
          )
        ORDER BY n.nspname, c.relname
    LOOP
        IF target.object_kind IN ('r', 'p', 'f') THEN
            EXECUTE format('ALTER TABLE %I.%I OWNER TO schema_owner', target.schema_name, target.object_name);
        ELSIF target.object_kind = 'v' THEN
            EXECUTE format('ALTER VIEW %I.%I OWNER TO schema_owner', target.schema_name, target.object_name);
        ELSIF target.object_kind = 'm' THEN
            EXECUTE format('ALTER MATERIALIZED VIEW %I.%I OWNER TO schema_owner', target.schema_name, target.object_name);
        ELSIF target.object_kind = 'S' THEN
            EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO schema_owner', target.schema_name, target.object_name);
        END IF;
    END LOOP;

    -- 函数 / 过程：带完整参数签名，避免同名重载被漏掉。
    FOR target IN
        SELECT n.nspname AS schema_name,
               p.proname AS object_name,
               pg_get_function_identity_arguments(p.oid) AS object_args,
               p.prokind AS object_kind
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('public', 'drizzle')
          AND p.prokind IN ('f', 'p', 'a')
          AND NOT EXISTS (
              SELECT 1 FROM pg_depend d
              WHERE d.objid = p.oid AND d.deptype = 'e'
          )
        ORDER BY n.nspname, p.proname
    LOOP
        IF target.object_kind = 'p' THEN
            EXECUTE format('ALTER PROCEDURE %I.%I(%s) OWNER TO schema_owner',
                target.schema_name, target.object_name, target.object_args);
        ELSIF target.object_kind = 'a' THEN
            EXECUTE format('ALTER AGGREGATE %I.%I(%s) OWNER TO schema_owner',
                target.schema_name, target.object_name, target.object_args);
        ELSE
            EXECUTE format('ALTER FUNCTION %I.%I(%s) OWNER TO schema_owner',
                target.schema_name, target.object_name, target.object_args);
        END IF;
    END LOOP;
END
$adopt$;
