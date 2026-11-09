import { accountChoiceRow } from './community-account-pages.js'
import type { SignedInAccountView } from '../domain/admin-contract.js'
import { zhErrorMessages } from '../domain/platform-error-messages.js'
import { platformText, platformError } from '../domain/platform-copy.js'
import type { PlatformLocale, PlatformLanguagePreference } from '../domain/platform-language.js'
import { platformPage } from './platform-page.js'
const recoveryCss = `
.recovery-page .entry-controls{position:static;max-width:640px;margin:0 auto 16px;justify-content:flex-end}
.recovery-page main{max-width:640px;margin:0 auto;font-size:14px}
.recovery-page main>.brand{margin-bottom:20px}
.recovery-page h1{margin:0 0 20px}
.recovery-page h2{font-size:16px;margin:0 0 10px}
.recovery-page main p{margin:0 0 8px}
.recovery-page main button{min-height:36px}
.recovery-page .recovery-confirm{display:flex;align-items:flex-start;gap:8px;margin:16px 0 12px}
.recovery-confirm input{flex:none;margin:4px 0 0}
.recovery-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px 16px}
.recovery-page #status{min-height:0}
.recovery-page .recovery-status{margin:0;overflow-wrap:anywhere}
.recovery-page .recovery-status:not(:empty){margin-block-start:12px;padding:8px 12px;background:var(--surface-secondary);border-radius:calc(var(--radius) * 2);color:var(--foreground)}
.recovery-tabs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;padding:4px;margin:0 0 20px;background:var(--surface-secondary);border-radius:calc(var(--radius) * 3)}
.recovery-tabs button{padding:6px 8px;background:transparent;color:var(--muted);border-radius:calc(var(--radius) * 2);line-height:1.3}
.recovery-tabs button:hover{background:var(--default);color:var(--foreground)}
.recovery-tabs button[aria-selected=true]{background:var(--surface);color:var(--foreground);box-shadow:0 0 0 1px var(--border);font-weight:600}
.recovery-account{margin-top:20px;padding-top:12px;border-top:1px solid var(--separator)}
.recovery-page main summary{font-weight:600;cursor:pointer;padding:6px 0}
.recovery-account details[open]>summary{margin-bottom:12px}
.recovery-page .recovery-reset,.recovery-page .recovery-logout{background:transparent;border:1px solid var(--border);color:var(--foreground)}
.recovery-page .recovery-reset{color:var(--danger-ink)}
.recovery-page .recovery-reset:hover,.recovery-page .recovery-logout:hover{background:var(--default)}
.recovery-account form[action="/logout"]{margin-top:8px}
`

/** Static platform page remains available when the user's DSH cannot load. */
export function communityRecoveryPage(
  locale: PlatformLocale = 'en',
  preference: PlatformLanguagePreference = 'system',
  accounts: readonly SignedInAccountView[] = [],
  showRestart = false,
): string {
  const t = (key: Parameters<typeof platformText>[1]) => platformText(locale, key)
  const errors = locale === 'en' ? {} : Object.fromEntries(Object.keys(zhErrorMessages).map(code => [code, platformError(locale, { code, error: '' })]))
  return platformPage(
    t('Instance recovery'),
    `<h1>${t('Instance recovery')}</h1>
<div class="recovery-tabs" role="tablist" aria-label="${t('Instance recovery')}">
<button type="button" role="tab" id="restart-tab" aria-controls="restart-panel" aria-selected="${showRestart}" tabindex="${showRestart ? 0 : -1}">${t('Restart instance')}</button>
<button type="button" role="tab" id="reset-tab" aria-controls="reset-panel" aria-selected="${!showRestart}" tabindex="${showRestart ? -1 : 0}">${t('Reset DSH environment')}</button>
</div>
<section id="restart-panel" role="tabpanel" aria-labelledby="restart-tab"${showRestart ? '' : ' hidden'}>
<h2 id="restart-title">${t('Restart instance')}</h2>
<p>${t('Restart your instance while keeping your configuration, plugins, conversations and files.')}</p>
<p>${t('Running tasks and terminal commands will be interrupted. Other members keep working.')}</p>
<form id="restart">
<label class="recovery-confirm"><input type="checkbox" required><span>${t('I understand that my running tasks will be interrupted')}</span></label>
<div class="recovery-actions"><button type="submit">${t('Restart instance')}</button><a data-recovery-return href="/enter">${t('Return to DSH')}</a></div>
</form>
<p class="recovery-status" id="status" role="status" aria-live="polite"></p>
</section>
<section id="reset-panel" role="tabpanel" aria-labelledby="reset-tab"${showRestart ? ' hidden' : ''}>
<h2 id="reset-title">${t('Reset DSH environment')}</h2>
<p>${t('This resets DSH configuration and self-installed plugins.')}</p>
<p>${t('Projects, conversations and other personal files are preserved.')}</p>
<p>${t('Member reset requests are limited to once every 10 minutes. Administrators are exempt.')}</p>
<p>${t('The latest three complete environment backups are retained per member.')}</p>
<p>${t('To recover an older configuration, contact an administrator.')}</p>
<form id="reset-environment">
<label class="recovery-confirm"><input type="checkbox" required><span>${t('I understand that tasks will be interrupted and my configuration and self-installed plugins will be reset.')}</span></label>
<div class="recovery-actions"><button class="recovery-reset" type="submit">${t('Reset environment')}</button><a data-recovery-return href="/enter">${t('Return to DSH')}</a></div>
</form>
<p class="recovery-status" id="reset-status" role="status" aria-live="polite"></p>
</section>
<div class="recovery-account">
<details id="signed-in-accounts"><summary>${t('Switch accounts')}</summary><p>${t('Accounts you signed in to on this browser.')}</p><ul class="account-list" aria-label="${t('Switch accounts')}">${accounts.map(account => accountChoiceRow(locale, account)).join('')}</ul><div class="account-list-actions"><a class="account-other" href="/login?other=1">${t('Add account')}</a><form method="post" action="/account/signed-in/remove-all"><button type="submit" class="account-remove-all">${t('Sign out of all accounts')}</button></form></div></details>
<form action="/logout" method="post"><button class="recovery-logout" type="submit">${t('Log out')}</button></form>
</div>`,
    `
const tabs=[...document.querySelectorAll('.recovery-tabs [role=tab]')];
function selectRecoveryTab(selected){
 for(const tab of tabs){
  const active=tab===selected;
  tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;
  document.getElementById(tab.getAttribute('aria-controls')).hidden=!active;
 }
 const url=new URL(location.href);
 if(selected.id==='restart-tab')url.searchParams.set('restart','1');
 else url.searchParams.delete('restart');
 history.replaceState(history.state,'',url);
}
for(const [index,tab] of tabs.entries()){
 tab.addEventListener('click',()=>selectRecoveryTab(tab));
 tab.addEventListener('keydown',event=>{
  let target;
  if(event.key==='Home')target=tabs[0];
  else if(event.key==='End')target=tabs[tabs.length-1];
  else if(event.key==='ArrowLeft'||event.key==='ArrowRight')target=tabs[(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];
  else return;
  event.preventDefault();selectRecoveryTab(target);target.focus();
 });
}
const errors=${JSON.stringify(errors)};
function connectRecovery(formId,statusId,path,working,success,failure){
 document.getElementById(formId).addEventListener('submit',async event=>{
  event.preventDefault();const button=event.currentTarget.querySelector('button');const status=document.getElementById(statusId);
  button.disabled=true;status.textContent=working;
  try{const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmed:true})});
   const result=await response.json();if(!response.ok){let message=errors[result.code]||result.error||${JSON.stringify(t('Request failed'))};for(const [key,value] of Object.entries(result.params||{}))message=message.split('{'+key+'}').join(String(value));throw new Error(message)};
   status.textContent=success;for(const link of document.querySelectorAll('[data-recovery-return]'))link.href=result.entry;
  }catch(error){status.textContent=failure.replace('{error}',()=>error.message)}
  finally{button.disabled=false}
 });
}
connectRecovery('restart','status','/recovery/restart',${JSON.stringify(t('Restarting your instance…'))},${JSON.stringify(t('Instance restarted. Your saved data is ready.'))},${JSON.stringify(t('Restart failed. {error} You can retry or ask an administrator to reset your DSH environment.'))});
connectRecovery('reset-environment','reset-status','/recovery/reset',${JSON.stringify(t('Resetting your DSH environment…'))},${JSON.stringify(t('DSH environment reset. Your projects, conversations and files are preserved.'))},${JSON.stringify(t('Reset failed. {error}'))});
`,
    { className: 'recovery-page', css: recoveryCss },
    locale,
    preference,
  )
}
export const COMMUNITY_RECOVERY_PAGE = communityRecoveryPage()
