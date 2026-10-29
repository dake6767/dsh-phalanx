/** Ordered platform migration for fresh community accounts and bootstrap state. */
export const accountSchema = `
CREATE TABLE dsh_phalanx.groups(
 id text PRIMARY KEY, name text NOT NULL UNIQUE, kind text NOT NULL CHECK(kind IN ('ordinary','admin')),
 is_default boolean NOT NULL DEFAULT false, CHECK(kind != 'admin' OR NOT is_default));
CREATE UNIQUE INDEX one_default_group ON dsh_phalanx.groups(is_default) WHERE is_default;
CREATE UNIQUE INDEX one_admin_group ON dsh_phalanx.groups(kind) WHERE kind='admin';
INSERT INTO dsh_phalanx.groups VALUES('default','Default group','ordinary',true),('admin','Administrators','admin',false);
CREATE TABLE dsh_phalanx.accounts(
 username text PRIMARY KEY CHECK(username=lower(username)), email text, password_hash text NOT NULL,
 admin boolean NOT NULL, disabled boolean NOT NULL DEFAULT false,
 session_epoch bigint NOT NULL DEFAULT 0 CHECK(session_epoch>=0),
 created_at bigint NOT NULL, updated_at bigint NOT NULL,
 space_id text NOT NULL UNIQUE, storage_key text NOT NULL, group_id text NOT NULL REFERENCES dsh_phalanx.groups(id));
CREATE UNIQUE INDEX account_email ON dsh_phalanx.accounts(lower(email));
CREATE TABLE dsh_phalanx.retired_accounts(username text PRIMARY KEY CHECK(username=lower(username)), retired_at bigint NOT NULL);
CREATE TABLE dsh_phalanx.bootstrap_state(id integer PRIMARY KEY CHECK(id=1), completed boolean NOT NULL);
INSERT INTO dsh_phalanx.bootstrap_state VALUES(1,false);
`
