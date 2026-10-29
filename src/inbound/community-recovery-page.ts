import { zhErrorMessages } from '../domain/platform-error-messages.js'
import { platformText, platformError } from '../domain/platform-copy.js'
import type { PlatformLocale, PlatformLanguagePreference } from '../domain/platform-language.js'
import { platformPage } from './platform-page.js'
/** Static platform page remains available when the user's DSH cannot load. */
export function communityRecoveryPage(locale: PlatformLocale = 'en', preference: PlatformLanguagePreference = 'system'): string {
  const t = (key: Parameters<typeof platformText>[1]) => platformText(locale, key)
  const errors = locale === 'en' ? {} : Object.fromEntries(Object.keys(zhErrorMessages).map(code => [code, platformError(locale, { code, error: '' })]))
  return platformPage(
    t('Instance recovery'),
    `<h1>${t('Instance recovery')}</h1><section><p>${t('Restart your instance while keeping your configuration, plugins, conversations and files.')}</p>
<p>${t('Running tasks and terminal commands will be interrupted. Other members keep working.')}</p>
<form id="restart"><label><input type="checkbox" required> ${t('I understand that my running tasks will be interrupted')}</label>
<button type="submit">${t('Restart instance')}</button></form><p id="status" role="status" aria-live="polite"></p></section>
<section><h2>${t('Reset DSH environment')}</h2><p>${t('This resets DSH configuration and self-installed plugins.')}</p>
<p>${t('Projects, conversations and other personal files are preserved.')}</p><p>${t('Member reset requests are limited to once every 10 minutes. Administrators are exempt.')}</p>
<p>${t('The latest three complete environment backups are retained per member.')}</p><p>${t('To recover an older configuration, contact an administrator.')}</p>
<form id="reset-environment"><label><input type="checkbox" required> ${t('I understand that tasks will be interrupted and my configuration and self-installed plugins will be reset.')}</label>
<button type="submit">${t('Reset environment')}</button></form><p id="reset-status" role="status" aria-live="polite"></p></section>
<nav><a id="return" href="/enter">${t('Return to DSH')}</a><form action="/logout" method="post"><button>${t('Log out')}</button></form></nav>`,
    `
const errors=${JSON.stringify(errors)};
function connectRecovery(formId,statusId,path,working,success,failure){
 document.getElementById(formId).addEventListener('submit',async event=>{
  event.preventDefault();const button=event.currentTarget.querySelector('button');const status=document.getElementById(statusId);
  button.disabled=true;status.textContent=working;
  try{const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmed:true})});
   const result=await response.json();if(!response.ok){let message=errors[result.code]||result.error||${JSON.stringify(t('Request failed'))};for(const [key,value] of Object.entries(result.params||{}))message=message.split('{'+key+'}').join(String(value));throw new Error(message)};
   status.textContent=success;document.getElementById('return').href=result.entry;
  }catch(error){status.textContent=failure.replace('{error}',()=>error.message)}
  finally{button.disabled=false}
 });
}
connectRecovery('restart','status','/recovery/restart',${JSON.stringify(t('Restarting your instance…'))},${JSON.stringify(t('Instance restarted. Your saved data is ready.'))},${JSON.stringify(t('Restart failed. {error} You can retry or ask an administrator to reset your DSH environment.'))});
connectRecovery('reset-environment','reset-status','/recovery/reset',${JSON.stringify(t('Resetting your DSH environment…'))},${JSON.stringify(t('DSH environment reset. Your projects, conversations and files are preserved.'))},${JSON.stringify(t('Reset failed. {error}'))});
`,
    undefined,
    locale,
    preference,
  )
}
export const COMMUNITY_RECOVERY_PAGE = communityRecoveryPage()
