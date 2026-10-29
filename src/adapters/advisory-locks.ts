/**
 * Every PostgreSQL advisory lock the platform takes, named by what it serializes.
 * The numbers are part of the deployed contract: a running older process and a
 * maintenance tool must agree on them, so they never change once released.
 */
export const AdvisoryLock = {
  /** Schema preparation and migrations, one process at a time (transaction scope). */
  migration: 1685282896,
  /** Account, group and bootstrap writes (transaction scope). */
  accounts: 1685282898,
  /** The production deployment's session ownership of this database (session scope). */
  deployment: 1685282900,
} as const

/** Key for the execution-configuration writer, derived in SQL from its table name. */
export const EXECUTION_CONFIGURATION_LOCK_SQL = "hashtext('dsh_phalanx.execution_configurations')"

export const transactionLock = (key: number) => `SELECT pg_advisory_xact_lock(${key})`
/** Hold account/group policy stable without serializing independent business transactions. */
export const transactionSharedLock = (key: number) => `SELECT pg_advisory_xact_lock_shared(${key})`

/** Serializes only competing delegated command names; parameter 1 is the exact command. */
export const executionCommandLock = "SELECT pg_advisory_xact_lock(hashtextextended('dsh_phalanx.execution.command:' || $1,0))"

/** Roots and private candidates share one MCP name namespace; parameter 1 is one name. */
export const mcpNameLock = "SELECT pg_advisory_xact_lock(hashtextextended('dsh_phalanx.mcp.name:' || $1,0))"

/** Serializes publication of competing prepared runtime commands; parameter 1 is the exact command. */
export const runtimeCommandLock = "SELECT pg_advisory_xact_lock(hashtextextended('dsh_phalanx.runtime.command:' || $1,0))"

/** Competing contributions share one library-name decision; parameters are kind and exact name. */
export const contributionNameLock = "SELECT pg_advisory_xact_lock(hashtextextended('dsh_phalanx.contribution.name:' || $1 || ':' || $2,0))"

/** Serializes the catalog's bounded request ledger, before its per-entry and library fact locks. */
export const catalogRequestLock = "SELECT pg_advisory_xact_lock(hashtextextended('dsh_phalanx.catalog.requests',0))"
