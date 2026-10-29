/** Each catalog id and request has an independent optimistic row; receipts outlive uninstall. */
export const catalogSchema = `
CREATE TABLE dsh_phalanx.catalog_installs(
 entry_id text PRIMARY KEY, state text NOT NULL CHECK(state IN ('installing','installed','failed','uninstalling','updating')),
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object'), row_revision text NOT NULL);
CREATE TABLE dsh_phalanx.catalog_requests(
 request_id text PRIMARY KEY, result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'), row_revision text NOT NULL,
 position bigint NOT NULL UNIQUE CHECK(position>0));
`
