/** Service rows and policy relations have independent revisions; empty settings remain explicit. */
export const mcpRelationsSchema = `
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM dsh_phalanx.mcp_state) OR EXISTS(SELECT 1 FROM dsh_phalanx.mcp_secrets) THEN
  RAISE EXCEPTION 'Fresh installation is required for MCP relation storage';
 END IF;
END $$;
DROP TABLE dsh_phalanx.mcp_secrets;
DROP TABLE dsh_phalanx.mcp_state;
CREATE TABLE dsh_phalanx.mcp_services(
 name text PRIMARY KEY, configuration jsonb NOT NULL, protected_fields jsonb NOT NULL DEFAULT '[]',
 generation bigint NOT NULL CHECK(generation>=0), row_revision text NOT NULL);
CREATE TABLE dsh_phalanx.mcp_secrets(
 service text NOT NULL REFERENCES dsh_phalanx.mcp_services(name) ON DELETE CASCADE ON UPDATE CASCADE,
 scope text NOT NULL, field text NOT NULL, value jsonb, PRIMARY KEY(service,scope,field));
CREATE TABLE dsh_phalanx.mcp_metadata(
 id integer PRIMARY KEY CHECK(id=1), last_generation bigint NOT NULL DEFAULT 0, last_request bigint NOT NULL DEFAULT 0);
INSERT INTO dsh_phalanx.mcp_metadata(id) VALUES(1);
CREATE TABLE dsh_phalanx.mcp_group_settings(
 group_id text PRIMARY KEY REFERENCES dsh_phalanx.groups ON DELETE CASCADE, row_revision text NOT NULL);
CREATE TABLE dsh_phalanx.mcp_group_grants(
 group_id text NOT NULL REFERENCES dsh_phalanx.mcp_group_settings ON DELETE CASCADE,
 service text NOT NULL REFERENCES dsh_phalanx.mcp_services ON DELETE CASCADE ON UPDATE CASCADE, PRIMARY KEY(group_id,service));
CREATE TABLE dsh_phalanx.mcp_member_settings(
 space_id text PRIMARY KEY REFERENCES dsh_phalanx.accounts(space_id) ON DELETE CASCADE,
 selections_configured boolean NOT NULL, preferences_configured boolean NOT NULL, row_revision text NOT NULL,
 CHECK(selections_configured OR preferences_configured));
CREATE TABLE dsh_phalanx.mcp_selections(
 space_id text NOT NULL REFERENCES dsh_phalanx.mcp_member_settings ON DELETE CASCADE,
 service text NOT NULL REFERENCES dsh_phalanx.mcp_services ON DELETE CASCADE ON UPDATE CASCADE, PRIMARY KEY(space_id,service));
CREATE TABLE dsh_phalanx.mcp_preferences(
 space_id text NOT NULL REFERENCES dsh_phalanx.mcp_member_settings ON DELETE CASCADE,
 service text NOT NULL REFERENCES dsh_phalanx.mcp_services ON DELETE CASCADE ON UPDATE CASCADE,
 enabled boolean NOT NULL, PRIMARY KEY(space_id,service));
CREATE TABLE dsh_phalanx.mcp_catalog_requests(request_id text PRIMARY KEY, position bigint NOT NULL UNIQUE);
`
