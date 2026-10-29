/** Plugin facts and their independently owned relations; artifacts stay outside PostgreSQL. */
export const pluginSchema = `
CREATE TABLE dsh_phalanx.plugin_library(
 package_name text PRIMARY KEY, version text NOT NULL,
 stage text NOT NULL CHECK(stage IN ('resolving','downloading','installing','prechecking','available','failed')),
 published boolean NOT NULL, current jsonb, replacement jsonb, identities jsonb, provenance jsonb,
 suite_origin text, configuration jsonb NOT NULL, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
CREATE TABLE dsh_phalanx.plugin_uploads(
 package_name text NOT NULL REFERENCES dsh_phalanx.plugin_library ON DELETE CASCADE,
 scope text NOT NULL CHECK(scope IN ('current','replacement')), archive text NOT NULL, integrity text NOT NULL,
 PRIMARY KEY(package_name,scope));
CREATE TABLE dsh_phalanx.plugin_grants(
 group_id text NOT NULL REFERENCES dsh_phalanx.groups ON DELETE CASCADE,
 package_name text NOT NULL REFERENCES dsh_phalanx.plugin_library ON DELETE CASCADE,
 mode text NOT NULL CHECK(mode IN ('controlled','preinstall')), PRIMARY KEY(group_id,package_name));
CREATE TABLE dsh_phalanx.plugin_grant_receipts(
 group_id text NOT NULL REFERENCES dsh_phalanx.groups ON DELETE CASCADE,
 package_name text NOT NULL REFERENCES dsh_phalanx.plugin_library ON DELETE CASCADE,
 receipt jsonb NOT NULL, PRIMARY KEY(group_id,package_name));
CREATE TABLE dsh_phalanx.plugin_choices(
 space_id text NOT NULL REFERENCES dsh_phalanx.accounts(space_id) ON DELETE CASCADE,
 package_name text NOT NULL REFERENCES dsh_phalanx.plugin_library ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('selected','local')), PRIMARY KEY(space_id,package_name,kind));
CREATE TABLE dsh_phalanx.plugin_deliveries(
 space_id text NOT NULL REFERENCES dsh_phalanx.accounts(space_id) ON DELETE CASCADE,
 package_name text NOT NULL, version text NOT NULL, source text NOT NULL CHECK(source IN ('selected','preinstall')),
 PRIMARY KEY(space_id,package_name));
-- These legacy protected stores were independent before the plugin parent existed.
-- This fresh-install release does not import file library facts. Existing orphan
-- configurations refuse the migration and roll it back without deleting old facts.
ALTER TABLE dsh_phalanx.plugin_access_settings ADD FOREIGN KEY(package_name) REFERENCES dsh_phalanx.plugin_library ON DELETE CASCADE;
ALTER TABLE dsh_phalanx.plugin_upstream_settings ADD FOREIGN KEY(package_name) REFERENCES dsh_phalanx.plugin_library ON DELETE CASCADE;
`
