/** Ordered platform migration: usage metadata, settings and aggregate buckets. */
export const usageSchema = `
CREATE TABLE dsh_phalanx.usage_records (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, username text NOT NULL, group_id text,
 kind text NOT NULL, capability text NOT NULL, operation text NOT NULL,
 started_at bigint NOT NULL, duration_ms double precision NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('succeeded','failed','denied')), http_status integer, reason text,
 is_error integer, first_argument text, exit_code integer
);
CREATE INDEX usage_started ON dsh_phalanx.usage_records(started_at);
CREATE INDEX usage_member ON dsh_phalanx.usage_records(username,started_at);
CREATE TABLE dsh_phalanx.usage_settings(id integer PRIMARY KEY CHECK(id=1), retention_days integer NOT NULL CHECK(retention_days BETWEEN 1 AND 3650));
INSERT INTO dsh_phalanx.usage_settings VALUES(1,180);
CREATE TABLE dsh_phalanx.usage_imports(source text PRIMARY KEY);
CREATE TABLE dsh_phalanx.usage_model_hours(
 username text NOT NULL, model_id text NOT NULL, group_id text NOT NULL, hour bigint NOT NULL,
 requests bigint NOT NULL, unknown_requests bigint NOT NULL, denied_requests bigint NOT NULL,
 input_tokens bigint, output_tokens bigint, cache_read bigint, cache_write bigint,
 PRIMARY KEY(username,model_id,group_id,hour));
CREATE INDEX usage_model_hour ON dsh_phalanx.usage_model_hours(hour);
CREATE TABLE dsh_phalanx.usage_reported_days(
 username text NOT NULL, group_id text NOT NULL, skill text NOT NULL, day bigint NOT NULL,
 count bigint NOT NULL CHECK(count BETWEEN 1 AND 9007199254740991), PRIMARY KEY(username,group_id,skill,day));
CREATE INDEX usage_reported_day ON dsh_phalanx.usage_reported_days(day);
`
