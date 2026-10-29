/** Runtime metadata and reference ownership commit together; prepared trees stay outside SQL. */
export const runtimeSchema = `
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM dsh_phalanx.skills WHERE runtime_dependencies IS NOT NULL AND runtime_dependencies<>'[]'::jsonb)
 OR EXISTS(SELECT 1 FROM dsh_phalanx.plugin_library WHERE COALESCE(configuration->'runtimeDependencies','[]'::jsonb)<>'[]'::jsonb)
 OR EXISTS(SELECT 1 FROM dsh_phalanx.execution_configurations WHERE COALESCE(configuration->'runtimeDependencies','[]'::jsonb)<>'[]'::jsonb) THEN
  RAISE EXCEPTION 'Fresh installation is required for runtime dependency relation storage';
 END IF;
END $$;
ALTER TABLE dsh_phalanx.execution_configurations ADD COLUMN source_skill text;
UPDATE dsh_phalanx.execution_configurations SET source_skill=substring(owner FROM 7) WHERE owner LIKE 'skill:%';
ALTER TABLE dsh_phalanx.execution_configurations ALTER COLUMN source_skill SET NOT NULL;
ALTER TABLE dsh_phalanx.execution_configurations ADD CONSTRAINT execution_source_identity CHECK(owner='skill:'||source_skill);
ALTER TABLE dsh_phalanx.execution_configurations ADD CONSTRAINT execution_source_skill
 FOREIGN KEY(source_skill) REFERENCES dsh_phalanx.skills(name) ON DELETE CASCADE;
CREATE TABLE dsh_phalanx.runtime_dependencies(
 name text PRIMARY KEY, definition jsonb NOT NULL, current_version jsonb, previous_version jsonb,
 stage text NOT NULL CHECK(stage IN ('preparing','validating','ready','failed')),
 updated_at bigint NOT NULL, log_summary text NOT NULL, checks jsonb NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
CREATE TABLE dsh_phalanx.skill_runtime_dependencies(
 dependency text NOT NULL REFERENCES dsh_phalanx.runtime_dependencies(name) ON DELETE RESTRICT,
 owner_id text NOT NULL REFERENCES dsh_phalanx.skills(name) ON DELETE CASCADE ON UPDATE CASCADE,
 owner_scope text NOT NULL DEFAULT 'current', position integer NOT NULL CHECK(position>=0),
 PRIMARY KEY(dependency,owner_id,owner_scope),
 UNIQUE(owner_id,owner_scope,position) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE dsh_phalanx.plugin_runtime_dependencies(
 dependency text NOT NULL REFERENCES dsh_phalanx.runtime_dependencies(name) ON DELETE RESTRICT,
 owner_id text NOT NULL REFERENCES dsh_phalanx.plugin_library(package_name) ON DELETE CASCADE ON UPDATE CASCADE,
 owner_scope text NOT NULL DEFAULT 'current', position integer NOT NULL CHECK(position>=0),
 PRIMARY KEY(dependency,owner_id,owner_scope),
 UNIQUE(owner_id,owner_scope,position) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE dsh_phalanx.mcp_runtime_dependencies(
 dependency text NOT NULL REFERENCES dsh_phalanx.runtime_dependencies(name) ON DELETE RESTRICT,
 owner_id text NOT NULL REFERENCES dsh_phalanx.mcp_services(name) ON DELETE CASCADE ON UPDATE CASCADE,
 owner_scope text NOT NULL DEFAULT 'current', position integer NOT NULL CHECK(position>=0),
 PRIMARY KEY(dependency,owner_id,owner_scope),
 UNIQUE(owner_id,owner_scope,position) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE dsh_phalanx.execution_runtime_dependencies(
 dependency text NOT NULL REFERENCES dsh_phalanx.runtime_dependencies(name) ON DELETE RESTRICT,
 owner_id text NOT NULL REFERENCES dsh_phalanx.execution_configurations(owner) ON DELETE CASCADE ON UPDATE CASCADE,
 owner_scope text NOT NULL DEFAULT 'current', position integer NOT NULL CHECK(position>=0),
 PRIMARY KEY(dependency,owner_id,owner_scope),
 UNIQUE(owner_id,owner_scope,position) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE dsh_phalanx.execution_limits(
 id integer PRIMARY KEY CHECK(id=1), limits jsonb NOT NULL, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
`
