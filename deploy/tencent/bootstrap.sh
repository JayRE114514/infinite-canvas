#!/bin/sh
set -eu

: "${SCHEMA_OWNER_PASSWORD:?missing SCHEMA_OWNER_PASSWORD}"
: "${APP_API_PASSWORD:?missing APP_API_PASSWORD}"
: "${APP_WORKER_PASSWORD:?missing APP_WORKER_PASSWORD}"
: "${APP_MAINTENANCE_PASSWORD:?missing APP_MAINTENANCE_PASSWORD}"

psql --set=ON_ERROR_STOP=1 --file=/bootstrap/roles.sql

psql \
  --set=ON_ERROR_STOP=1 \
  --set=schema_owner_password="$SCHEMA_OWNER_PASSWORD" \
  --set=app_api_password="$APP_API_PASSWORD" \
  --set=app_worker_password="$APP_WORKER_PASSWORD" \
  --set=app_maintenance_password="$APP_MAINTENANCE_PASSWORD" <<'SQL'
ALTER ROLE schema_owner PASSWORD :'schema_owner_password';
ALTER ROLE app_api PASSWORD :'app_api_password';
ALTER ROLE app_worker PASSWORD :'app_worker_password';
ALTER ROLE app_maintenance PASSWORD :'app_maintenance_password';

REVOKE CONNECT ON DATABASE infinite_canvas FROM PUBLIC;
GRANT CONNECT ON DATABASE infinite_canvas TO schema_owner, app_api, app_worker, app_maintenance;
ALTER DATABASE infinite_canvas OWNER TO schema_owner;
SQL

psql --set=ON_ERROR_STOP=1 --file=/bootstrap/adopt-ownership.sql
