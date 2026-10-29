/** Skill facts reference prepared content; group and space lifetimes are enforced by PostgreSQL. */
export const skillSchema = `
CREATE TABLE dsh_phalanx.skills(
 name text PRIMARY KEY, description text NOT NULL, hash text NOT NULL, imported_at bigint NOT NULL,
 published boolean NOT NULL, conflict boolean, source jsonb, provenance jsonb, suite_origin text,
 runtime_dependencies jsonb, contribution_receipt jsonb, publication_receipt jsonb, distribution_receipt jsonb,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
CREATE TABLE dsh_phalanx.skill_packs(
 name text PRIMARY KEY, description text NOT NULL, instructions text NOT NULL, published boolean NOT NULL,
 suite_origin text, note jsonb, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
CREATE TABLE dsh_phalanx.skill_pack_members(
 pack_name text NOT NULL REFERENCES dsh_phalanx.skill_packs(name) ON DELETE CASCADE ON UPDATE CASCADE,
 skill_name text NOT NULL REFERENCES dsh_phalanx.skills(name) ON DELETE CASCADE,
 position integer NOT NULL CHECK(position>=0), PRIMARY KEY(pack_name,skill_name), UNIQUE(pack_name,position) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE dsh_phalanx.skill_group_grants(
 group_id text NOT NULL REFERENCES dsh_phalanx.groups ON DELETE CASCADE,
 name text NOT NULL REFERENCES dsh_phalanx.skills ON DELETE CASCADE, PRIMARY KEY(group_id,name));
CREATE TABLE dsh_phalanx.skill_selections(
 space_id text NOT NULL REFERENCES dsh_phalanx.accounts(space_id) ON DELETE CASCADE,
 name text NOT NULL REFERENCES dsh_phalanx.skills ON DELETE CASCADE, PRIMARY KEY(space_id,name));
CREATE TABLE dsh_phalanx.pack_group_grants(
 group_id text NOT NULL REFERENCES dsh_phalanx.groups ON DELETE CASCADE,
 name text NOT NULL REFERENCES dsh_phalanx.skill_packs ON DELETE CASCADE ON UPDATE CASCADE, PRIMARY KEY(group_id,name));
CREATE TABLE dsh_phalanx.pack_selections(
 space_id text NOT NULL REFERENCES dsh_phalanx.accounts(space_id) ON DELETE CASCADE,
 name text NOT NULL REFERENCES dsh_phalanx.skill_packs ON DELETE CASCADE ON UPDATE CASCADE, PRIMARY KEY(space_id,name));
CREATE TABLE dsh_phalanx.skill_grant_receipts(
 group_id text NOT NULL REFERENCES dsh_phalanx.groups ON DELETE CASCADE,
 name text NOT NULL REFERENCES dsh_phalanx.skills ON DELETE CASCADE, receipt jsonb NOT NULL, PRIMARY KEY(group_id,name));
CREATE TABLE dsh_phalanx.pack_grant_receipts(
 group_id text NOT NULL REFERENCES dsh_phalanx.groups ON DELETE CASCADE,
 name text NOT NULL REFERENCES dsh_phalanx.skill_packs ON DELETE CASCADE ON UPDATE CASCADE, receipt jsonb NOT NULL, PRIMARY KEY(group_id,name));
`
