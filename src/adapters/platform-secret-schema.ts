/** Protected model configuration; provider credentials are field-bound encrypted envelopes. */
export const secretSchema = `
CREATE TABLE dsh_phalanx.shared_model_settings (
  id integer PRIMARY KEY CHECK(id=1),
  revision bigint NOT NULL CHECK(revision>=0),
  default_model_id text
);
INSERT INTO dsh_phalanx.shared_model_settings(id,revision) VALUES(1,0);
CREATE TABLE dsh_phalanx.shared_model_providers (
  id text PRIMARY KEY,
  position integer NOT NULL UNIQUE CHECK(position>=0),
  configuration jsonb NOT NULL,
  api_key jsonb NOT NULL
);
CREATE TABLE dsh_phalanx.model_access_tokens (
  space_id text PRIMARY KEY REFERENCES dsh_phalanx.accounts(space_id) ON DELETE CASCADE,
  token jsonb NOT NULL
);
CREATE TABLE dsh_phalanx.session_signing_key (
  id integer PRIMARY KEY CHECK(id=1),
  signing_key jsonb NOT NULL
);`

/** Public upstream metadata survives independently of the protected field envelopes. */
export const protectedConfigurationSchema = `
CREATE TABLE dsh_phalanx.plugin_upstream_settings (
  package_name text PRIMARY KEY,
  revision text NOT NULL CHECK(revision<>''),
  receipt jsonb,
  configuration jsonb NOT NULL CHECK(jsonb_typeof(configuration)='array')
);
CREATE TABLE dsh_phalanx.plugin_upstreams (
  package_name text NOT NULL REFERENCES dsh_phalanx.plugin_upstream_settings(package_name) ON DELETE CASCADE,
  name text NOT NULL,
  credential jsonb,
  test_request jsonb,
  headers jsonb NOT NULL CHECK(jsonb_typeof(headers)='array'),
  PRIMARY KEY(package_name,name)
);
CREATE TABLE dsh_phalanx.execution_configurations (
  owner text PRIMARY KEY,
  revision text NOT NULL CHECK(revision<>''),
  configuration jsonb NOT NULL
);
CREATE TABLE dsh_phalanx.execution_variables (
  owner text NOT NULL REFERENCES dsh_phalanx.execution_configurations(owner) ON DELETE CASCADE,
  name text NOT NULL,
  value jsonb,
  PRIMARY KEY(owner,name)
);
CREATE TABLE dsh_phalanx.mcp_state (
  id integer PRIMARY KEY CHECK(id=1),
  state jsonb NOT NULL CHECK(jsonb_typeof(state)='object'),
  fields jsonb NOT NULL CHECK(jsonb_typeof(fields)='array'),
  commit_version bigint NOT NULL CHECK(commit_version>=0)
);
CREATE TABLE dsh_phalanx.mcp_secrets (
  state_id integer NOT NULL DEFAULT 1 REFERENCES dsh_phalanx.mcp_state(id) ON DELETE CASCADE CHECK(state_id=1),
  service text NOT NULL,
  scope text NOT NULL,
  field text NOT NULL,
  value jsonb,
  PRIMARY KEY(service,scope,field)
);
CREATE TABLE dsh_phalanx.plugin_access_settings (
  package_name text PRIMARY KEY,
  configuration jsonb NOT NULL CHECK(jsonb_typeof(configuration)='object'),
  fields jsonb NOT NULL CHECK(jsonb_typeof(fields)='array'),
  commit_version bigint NOT NULL CHECK(commit_version>=0)
);
CREATE TABLE dsh_phalanx.plugin_access_secrets (
  package_name text NOT NULL REFERENCES dsh_phalanx.plugin_access_settings(package_name) ON DELETE CASCADE,
  scope text NOT NULL,
  field text NOT NULL,
  value jsonb,
  PRIMARY KEY(package_name,scope,field)
);
CREATE TABLE dsh_phalanx.contribution_setups (
  reference text PRIMARY KEY,
  id text NOT NULL,
  revision text NOT NULL,
  configuration jsonb NOT NULL CHECK(jsonb_typeof(configuration)='object'),
  fields jsonb NOT NULL CHECK(jsonb_typeof(fields)='array')
);
CREATE TABLE dsh_phalanx.contribution_setup_secrets (
  reference text NOT NULL REFERENCES dsh_phalanx.contribution_setups(reference) ON DELETE CASCADE,
  field text NOT NULL,
  value jsonb,
  PRIMARY KEY(reference,field)
);`
