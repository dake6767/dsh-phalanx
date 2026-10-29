import { platformError, platformText } from '../domain/platform-copy.js'
import type { PlatformLocale } from '../domain/platform-language.js'

/** Credentials remain in the page closure; form fragments require server authorization. */
export function communityBootstrapScript(locale: PlatformLocale): string {
  const t = (key: Parameters<typeof platformText>[1]) => platformText(locale, key)
  const errors = Object.fromEntries(
    [
      'database-setup-closed',
      'bootstrap-credential-invalid',
      'database-selection-committed',
      'database-connection-check-failed',
      'database-connection-invalid',
    ].map(code => [code, platformError(locale, { code, error: '' })]),
  )
  return `
const content = document.getElementById('bootstrap-content'), instructions = document.getElementById('instructions');
const invalidLink = ${JSON.stringify(t('This initialization link is invalid. Use the current link printed by the installer.'))};
const requestFailed = ${JSON.stringify(t('Request failed'))}, errors = ${JSON.stringify(errors)};
const labels = ${JSON.stringify({ connection: t('Database connectivity'), version: t('PostgreSQL 14 or newer'), owner: t('Schema ownership'), schema: t('Empty or matching platform schema') })};
let authorization = 0;
async function post(fields) {
 const response = await fetch('/bootstrap', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: fields });
 const result = await response.json();
 if (!response.ok) { const message = errors[result.code] || requestFailed; throw Error(message.replace('{stage}', labels[result.params?.stage] || requestFailed)); }
 return result;
}
function showForm(html, credential) {
 content.innerHTML = html;
 const form = content.querySelector('form');
 form.querySelector('[name="credential"]').value = credential;
 if (form.id !== 'database-form') { form.querySelector('[name="username"]').focus(); return; }
 const kind = form.elements.databaseKind, external = form.querySelector('fieldset'), test = form.querySelector('#database-test'), next = form.querySelector('#database-continue'), status = form.querySelector('#database-status');
 let tested = false, busy = false;
 function update() {
  const remote = kind.value === 'external';
  kind.disabled = busy; external.hidden = !remote; external.disabled = !remote || busy;
  test.hidden = !remote; test.disabled = !remote || busy; next.disabled = busy || remote && !tested;
 }
 function changed() { tested = false; status.textContent = ''; update(); }
 kind.addEventListener('change', changed); external.addEventListener('input', changed);
 form.querySelector('#database-ca-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 16384) { status.textContent = requestFailed; event.target.value = ''; return; }
  try { form.elements.databaseCa.value = await file.text(); changed(); } catch { status.textContent = requestFailed; }
 });
 form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const action = event.submitter?.value || 'database-select', fields = new URLSearchParams();
  for (const [name,value] of new FormData(form)) if (typeof value === 'string') fields.append(name,value);
  fields.set('action', action); busy = true; update(); status.textContent = ${JSON.stringify(t('Testing database connection…'))};
  try {
   const result = await post(fields);
   if (result.html) { showForm(result.html, credential); return; }
   tested = result.ok === true;
   status.textContent = result.checks.map(check => (labels[check.stage] || requestFailed) + ': ' + (check.passed ? ${JSON.stringify(t('Passed'))} : ${JSON.stringify(t('Failed'))})).join(' · ') + (result.serverVersion ? ' (' + result.serverVersion + ')' : '');
  } catch (error) { tested = false; status.textContent = error.message; }
  finally { busy = false; if (content.contains(form)) update(); }
 });
 update(); kind.focus();
}
async function applyCredential() {
 const current = ++authorization, credential = new URLSearchParams(location.hash.slice(1)).get('credential');
 content.replaceChildren(); instructions.textContent = ${JSON.stringify(t('Open the initialization link printed by the installer to create your administrator account.'))};
 if (!credential) return;
 if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) { instructions.textContent = invalidLink; return; }
 try {
  const result = await post(new URLSearchParams({ action: 'database-authorize', credential }));
  if (current !== authorization) return;
  instructions.textContent = ''; showForm(result.html, credential);
 } catch (error) { if (current === authorization) { instructions.textContent = error.message; instructions.setAttribute('role','alert'); } }
}
addEventListener('hashchange', applyCredential); applyCredential();
`
}
