import { PLAYWRIGHT_NPM_PACKAGE } from '../domain/suite-resource-bindings.js'

// Read trusted browser mounts and their companion Chrome launcher from one catalog delivery.
const bindings = `CASE WHEN jsonb_typeof(l.configuration->'suiteResourceBindings')='array'
  THEN l.configuration->'suiteResourceBindings' ELSE '[]'::jsonb END`

export const catalogBrowserResources = `
CROSS JOIN LATERAL (
  SELECT b.value->>'runtimeDependency' AS name,
    jsonb_agg(b.value ORDER BY b.position) AS bindings
  FROM jsonb_array_elements(${bindings}) WITH ORDINALITY AS b(value, position)
  WHERE b.value->>'kind'='playwright-browser' OR b.value->>'name' IN ('PLAYWRIGHT_BROWSERS_PATH','CHROME_PATH')
  GROUP BY b.value->>'runtimeDependency'
  HAVING bool_or(b.value->>'kind'='playwright-browser' OR b.value->>'name'='PLAYWRIGHT_BROWSERS_PATH')
) browser`

const browserTitle = `COALESCE(NULLIF(l.current->>'title',''),l.package_name)`
const playwrightVersion = `(SELECT item->>'version' FROM jsonb_array_elements(${bindings}) b
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN b->>'kind'='native-package-cache' THEN b->'packages' ELSE '[]'::jsonb END) item
  WHERE item->>'packageName'='${PLAYWRIGHT_NPM_PACKAGE}' LIMIT 1)`

export const insertMemberBrowserDependencies = `
INSERT INTO dsh_phalanx.member_browser_dependencies(space_id, package_name, dependency, bindings, title, playwright_version)
SELECT d.space_id, d.package_name, browser.name, browser.bindings, ${browserTitle}, ${playwrightVersion}
FROM dsh_phalanx.plugin_deliveries d
JOIN dsh_phalanx.plugin_library l ON l.package_name=d.package_name AND l.suite_origin=d.resource_origin
  AND l.current->>'version'=d.version AND l.current->>'integrity'=d.integrity
${catalogBrowserResources}
JOIN dsh_phalanx.runtime_dependencies resource ON resource.name=browser.name`

export const reserveMemberBrowserResources = `
INSERT INTO dsh_phalanx.member_browser_reservations(id, space_id, package_name, dependency, bindings, title, playwright_version, version, integrity, origin, owner, generation)
SELECT $1, $2, l.package_name, browser.name, browser.bindings, ${browserTitle}, ${playwrightVersion}, $4, $5, $6, $7, $8
FROM dsh_phalanx.plugin_library l ${catalogBrowserResources}
WHERE l.package_name=$3 AND l.current->>'version'=$4 AND l.current->>'integrity'=$5 AND l.suite_origin=$6
RETURNING dependency`

const browserFields = `
  dependency text NOT NULL REFERENCES dsh_phalanx.runtime_dependencies(name) ON DELETE RESTRICT,
  bindings jsonb NOT NULL CHECK(jsonb_typeof(bindings)='array' AND jsonb_array_length(bindings)>0),
  title text NOT NULL,
  playwright_version text`

export const memberBrowserSchema = `
CREATE TABLE dsh_phalanx.member_browser_dependencies (
  space_id text NOT NULL,
  package_name text NOT NULL,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  ${browserFields},
  PRIMARY KEY(space_id,package_name,dependency),
  FOREIGN KEY(space_id,package_name) REFERENCES dsh_phalanx.plugin_deliveries(space_id,package_name) ON DELETE CASCADE
);
CREATE INDEX member_browser_dependencies_by_dependency ON dsh_phalanx.member_browser_dependencies(dependency);
CREATE TABLE dsh_phalanx.member_browser_reservations (
  id uuid NOT NULL,
  space_id text NOT NULL REFERENCES dsh_phalanx.accounts(space_id) ON DELETE CASCADE,
  package_name text NOT NULL,
  ${browserFields},
  version text NOT NULL,
  integrity text NOT NULL,
  origin text NOT NULL,
  owner uuid,
  generation text,
  PRIMARY KEY(id,dependency)
);
CREATE INDEX member_browser_reservations_by_dependency ON dsh_phalanx.member_browser_reservations(dependency);
${insertMemberBrowserDependencies};`
