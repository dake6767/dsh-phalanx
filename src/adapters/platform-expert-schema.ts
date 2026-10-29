/** Expert content has its own row identity and running-preset revision. */
export const expertSchema = `
CREATE TABLE dsh_phalanx.experts(
 id text PRIMARY KEY, revision bigint NOT NULL CHECK(revision>0),
 row_revision text NOT NULL, published boolean NOT NULL, definition jsonb NOT NULL);
CREATE TABLE dsh_phalanx.expert_skills(
 expert_id text NOT NULL REFERENCES dsh_phalanx.experts ON DELETE CASCADE,
 name text NOT NULL REFERENCES dsh_phalanx.skills(name) ON DELETE CASCADE ON UPDATE CASCADE,
 position integer NOT NULL CHECK(position>=0), PRIMARY KEY(expert_id,name),
 UNIQUE(expert_id,position) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE dsh_phalanx.expert_skill_packs(
 expert_id text NOT NULL REFERENCES dsh_phalanx.experts ON DELETE CASCADE,
 name text NOT NULL REFERENCES dsh_phalanx.skill_packs(name) ON DELETE CASCADE ON UPDATE CASCADE,
 position integer NOT NULL CHECK(position>=0), PRIMARY KEY(expert_id,name),
 UNIQUE(expert_id,position) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE dsh_phalanx.expert_plugins(
 expert_id text NOT NULL REFERENCES dsh_phalanx.experts ON DELETE CASCADE,
 name text NOT NULL REFERENCES dsh_phalanx.plugin_library(package_name) ON DELETE CASCADE,
 position integer NOT NULL CHECK(position>=0), PRIMARY KEY(expert_id,name),
 UNIQUE(expert_id,position) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE dsh_phalanx.expert_mcp(
 expert_id text NOT NULL REFERENCES dsh_phalanx.experts ON DELETE CASCADE,
 name text NOT NULL REFERENCES dsh_phalanx.mcp_services(name) ON DELETE CASCADE ON UPDATE CASCADE,
 position integer NOT NULL CHECK(position>=0), PRIMARY KEY(expert_id,name),
 UNIQUE(expert_id,position) DEFERRABLE INITIALLY DEFERRED);
-- An existing unavailable model is intentionally retained until explicitly cleared.
CREATE TABLE dsh_phalanx.expert_models(
 expert_id text PRIMARY KEY REFERENCES dsh_phalanx.experts ON DELETE CASCADE,
 provider_id text NOT NULL, name text NOT NULL);
CREATE TABLE dsh_phalanx.expert_metadata(
 id integer PRIMARY KEY CHECK(id=1), generation bigint NOT NULL CHECK(generation>=0));
INSERT INTO dsh_phalanx.expert_metadata VALUES(1,0);
CREATE TABLE dsh_phalanx.expert_group_settings(
 group_id text PRIMARY KEY REFERENCES dsh_phalanx.groups ON DELETE CASCADE, row_revision text NOT NULL);
CREATE TABLE dsh_phalanx.expert_grants(
 group_id text NOT NULL REFERENCES dsh_phalanx.expert_group_settings ON DELETE CASCADE,
 expert_id text NOT NULL REFERENCES dsh_phalanx.experts ON DELETE CASCADE, PRIMARY KEY(group_id,expert_id));
CREATE TABLE dsh_phalanx.expert_member_settings(
 space_id text PRIMARY KEY REFERENCES dsh_phalanx.accounts(space_id) ON DELETE CASCADE, row_revision text NOT NULL);
CREATE TABLE dsh_phalanx.expert_selections(
 space_id text NOT NULL REFERENCES dsh_phalanx.expert_member_settings ON DELETE CASCADE,
 expert_id text NOT NULL REFERENCES dsh_phalanx.experts ON DELETE CASCADE, PRIMARY KEY(space_id,expert_id));
`
