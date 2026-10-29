/** Global settings and independent per-space resource facts. */
export const spaceSchema = `
CREATE TABLE dsh_phalanx.user_storage_identity(
 id integer PRIMARY KEY CHECK(id=1),owner text NOT NULL CHECK(owner ~ '^[a-f0-9]{32}$'),revision bigint NOT NULL CHECK(revision>=0));
CREATE TABLE dsh_phalanx.user_storage_binding(
 id integer PRIMARY KEY REFERENCES dsh_phalanx.user_storage_identity(id) ON DELETE CASCADE CHECK(id=1),
 path text NOT NULL,storage_id text NOT NULL CHECK(storage_id ~ '^[a-f0-9]{32}$'),mount text NOT NULL);
CREATE TABLE dsh_phalanx.instance_resource_settings(
 id integer PRIMARY KEY CHECK(id=1), revision bigint NOT NULL CHECK(revision>=0),
 cpus double precision CHECK(cpus>0), memory_mib double precision CHECK(memory_mib>0), pids bigint CHECK(pids>0),
 idle_seconds bigint NOT NULL CHECK(idle_seconds>=0));
CREATE TABLE dsh_phalanx.instance_resource_overrides(
 space_id text PRIMARY KEY REFERENCES dsh_phalanx.accounts(space_id) ON DELETE CASCADE,
 cpus double precision CHECK(cpus>0), memory_mib double precision CHECK(memory_mib>0), pids bigint CHECK(pids>0));
CREATE TABLE dsh_phalanx.resident_instances(
 space_id text PRIMARY KEY REFERENCES dsh_phalanx.accounts(space_id) ON DELETE CASCADE);
CREATE TABLE dsh_phalanx.container_hostnames(
 space_id text PRIMARY KEY REFERENCES dsh_phalanx.accounts(space_id) ON DELETE CASCADE, hostname text NOT NULL);
CREATE TABLE dsh_phalanx.environment_reset_history(
 space_id text PRIMARY KEY REFERENCES dsh_phalanx.accounts(space_id) ON DELETE CASCADE,
 last_member_accepted_at bigint CHECK(last_member_accepted_at>=0),
 recent_at bigint NOT NULL CHECK(recent_at>=0),recent_username text NOT NULL,
 recent_role text NOT NULL CHECK(recent_role IN ('admin','member')));
CREATE FUNCTION dsh_phalanx.advance_resource_revision_on_account_delete() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN UPDATE dsh_phalanx.instance_resource_settings SET revision=revision+1 WHERE id=1; RETURN NULL; END $$;
CREATE TRIGGER advance_resource_revision_on_account_delete AFTER DELETE ON dsh_phalanx.accounts
 FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.advance_resource_revision_on_account_delete();
`
