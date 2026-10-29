import { accountSchema } from './platform-account-schema.js'
import { catalogSchema } from './platform-catalog-schema.js'
import { contributionSchema } from './platform-contribution-schema.js'
import { expertSchema } from './platform-expert-schema.js'
import { mcpRelationsSchema } from './platform-mcp-schema.js'
import { pluginSchema } from './platform-plugin-schema.js'
import { runtimeSchema } from './platform-runtime-schema.js'
import { protectedConfigurationSchema, secretSchema } from './platform-secret-schema.js'
import { skillSchema } from './platform-skill-schema.js'
import { spaceSchema } from './platform-space-schema.js'
import { usageSchema } from './platform-usage-schema.js'

export const PLATFORM_TABLES = [
  'schema_migrations',
  'platform_security',
  'groups',
  'accounts',
  'retired_accounts',
  'bootstrap_state',
  'usage_records',
  'usage_settings',
  'usage_model_hours',
  'usage_reported_days',
  'shared_model_settings',
  'shared_model_providers',
  'model_access_tokens',
  'session_signing_key',
  'plugin_library',
  'plugin_upstream_settings',
  'plugin_upstreams',
  'plugin_access_settings',
  'plugin_access_secrets',
  'contribution_setups',
  'contribution_setup_secrets',
  'platform_deployment',
  'master_key_backups',
  'download_sources',
  'plugin_uploads',
  'plugin_grants',
  'plugin_grant_receipts',
  'plugin_choices',
  'plugin_deliveries',
  'skills',
  'skill_packs',
  'skill_pack_members',
  'skill_group_grants',
  'skill_selections',
  'pack_group_grants',
  'pack_selections',
  'skill_grant_receipts',
  'pack_grant_receipts',
  'execution_configurations',
  'execution_variables',
  'mcp_services',
  'mcp_secrets',
  'mcp_metadata',
  'mcp_group_settings',
  'mcp_group_grants',
  'mcp_member_settings',
  'mcp_selections',
  'mcp_preferences',
  'mcp_catalog_requests',
  'runtime_dependencies',
  'skill_runtime_dependencies',
  'plugin_runtime_dependencies',
  'mcp_runtime_dependencies',
  'execution_runtime_dependencies',
  'execution_limits',
  'experts',
  'expert_skills',
  'expert_skill_packs',
  'expert_plugins',
  'expert_mcp',
  'expert_models',
  'expert_metadata',
  'expert_group_settings',
  'expert_grants',
  'expert_member_settings',
  'expert_selections',
  'contributions',
  'catalog_installs',
  'catalog_requests',
  'instance_resource_settings',
  'instance_resource_overrides',
  'resident_instances',
  'environment_reset_history',
  'container_hostnames',
  'user_storage_identity',
  'user_storage_binding',
] as const
/** Zero-argument platform routines introduced by recorded migrations, never unrelated schema functions. */
export const PLATFORM_ROUTINES = [
  { name: 'remove_pending_contributions', since: 13 },
  { name: 'advance_resource_revision_on_account_delete', since: 14 },
] as const
export const PLATFORM_RELATIONS = [...PLATFORM_TABLES, 'usage_records_id_seq']
export const platformCoreSchema = `CREATE SCHEMA IF NOT EXISTS dsh_phalanx;
  CREATE TABLE IF NOT EXISTS dsh_phalanx.schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS dsh_phalanx.platform_security(id integer PRIMARY KEY CHECK(id=1), registry jsonb NOT NULL);`
export const platformDeploymentSchema = 'CREATE TABLE dsh_phalanx.platform_deployment(id integer PRIMARY KEY CHECK(id=1),deployment_id text NOT NULL)'

export const platformBackupSchema = `CREATE TABLE dsh_phalanx.master_key_backups(fingerprint text PRIMARY KEY,username text NOT NULL,space_id text NOT NULL,confirmed_at timestamptz NOT NULL DEFAULT now());`
/** One deployment-wide selection; absent until an administrator saves, so the installed choice applies. */
export const platformDownloadSourcesSchema = `CREATE TABLE dsh_phalanx.download_sources(id integer PRIMARY KEY CHECK(id=1),selection jsonb NOT NULL CHECK(jsonb_typeof(selection)='object'),revision bigint NOT NULL CHECK(revision>0));`

/**
 * Ordered platform migrations. Version N is entry N; version 1 records the core
 * schema that every preparation applies first. Add a migration by appending one
 * entry with the next number; PLATFORM_SCHEMA_VERSION follows the last entry.
 * Never edit or reorder a released entry: deployed databases record which ran.
 */
export const PLATFORM_MIGRATIONS: readonly { readonly version: number; readonly name: string; readonly sql: string }[] = [
  { version: 1, name: 'core', sql: '' },
  { version: 2, name: 'usage records', sql: usageSchema },
  { version: 3, name: 'accounts', sql: accountSchema },
  { version: 4, name: 'protected models, tokens and session key', sql: secretSchema },
  { version: 5, name: 'protected plugin, MCP and execution configuration', sql: protectedConfigurationSchema },
  { version: 6, name: 'deployment identity', sql: platformDeploymentSchema },
  { version: 7, name: 'master-key backups', sql: platformBackupSchema },
  { version: 8, name: 'download sources', sql: platformDownloadSourcesSchema },
  { version: 9, name: 'plugin relations', sql: pluginSchema },
  { version: 10, name: 'skill relations', sql: skillSchema },
  { version: 11, name: 'MCP and runtime relations', sql: mcpRelationsSchema + runtimeSchema },
  { version: 12, name: 'expert relations', sql: expertSchema },
  { version: 13, name: 'contribution and catalog records', sql: contributionSchema + catalogSchema },
  { version: 14, name: 'space facts', sql: spaceSchema },
  { version: 15, name: 'retire legacy audit import markers', sql: 'DROP TABLE dsh_phalanx.usage_imports;' },
]

/** The newest version this code can prepare, always the last migration. */
export const PLATFORM_SCHEMA_VERSION = PLATFORM_MIGRATIONS.at(-1)!.version

/** Reuse the migration DDL, including identity/FK ownership, inside one transaction without requiring a second namespace. */
export function currentPlatformSchema(includeNamespace: boolean): string {
  return [platformCoreSchemaFor(includeNamespace), ...PLATFORM_MIGRATIONS.map(migration => migration.sql).filter(Boolean)]
    .map(sql => sql.replace(/;?\s*$/u, ';'))
    .join('\n')
}

export function platformCoreSchemaFor(includeNamespace: boolean): string {
  return includeNamespace ? platformCoreSchema : platformCoreSchema.replace('CREATE SCHEMA IF NOT EXISTS dsh_phalanx;', '')
}
