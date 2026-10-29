import { platformText } from '../domain/platform-copy.js'
import type { PlatformLocale } from '../domain/platform-language.js'

/** This fragment is returned only after server-side verification of the first-install invitation. */
export function communityDatabaseForm(locale: PlatformLocale): string {
  const t = (key: Parameters<typeof platformText>[1]) => platformText(locale, key)
  return `<h2>${t('Platform database')}</h2><form method="post" action="/bootstrap" id="database-form"><input name="credential" type="hidden"><label>${t('Platform database')}<select name="databaseKind" aria-label="${t('Platform database')}"><option value="builtin">${t('Built-in PostgreSQL (default)')}</option><option value="external">${t('External PostgreSQL')}</option></select></label>
<fieldset id="external-database" hidden disabled><legend>${t('External PostgreSQL')}</legend>
<label>${t('Database host')}<input name="databaseHost" required autocomplete="off"></label><label>${t('Database port')}<input name="databasePort" type="number" min="1" max="65535" value="5432" required></label>
<label>${t('Database name')}<input name="databaseName" required autocomplete="off"></label><label>${t('Database username')}<input name="databaseUsername" required autocomplete="off"></label><label>${t('Database password')}<input name="databasePassword" type="password" autocomplete="off"></label>
<label>${t('TLS mode')}<select name="databaseTls" aria-label="${t('TLS mode')}"><option value="disable">disable</option><option value="require">require</option><option value="verify-full">verify-full</option></select></label>
<label>${t('Upload CA certificate')}<input type="file" id="database-ca-file" accept=".crt,.pem,.cer"></label><label>${t('CA certificate (PEM)')}<textarea name="databaseCa" rows="4"></textarea></label></fieldset>
<p role="status" id="database-status" aria-live="polite"></p><button type="submit" name="action" value="database-test" id="database-test" hidden disabled>${t('Test connection')}</button><button type="submit" name="action" value="database-select" id="database-continue">${t('Continue')}</button></form>`
}
