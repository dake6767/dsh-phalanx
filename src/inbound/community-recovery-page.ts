import { zhErrorMessages } from '../domain/platform-error-messages.js'
import { platformText, platformError } from '../domain/platform-copy.js'
import type { PlatformLocale, PlatformLanguagePreference } from '../domain/platform-language.js'
import { platformPage } from './platform-page.js'
/** Static platform page remains available when the user's DSH cannot load. */
export function communityRecoveryPage(locale: PlatformLocale = 'en', preference: PlatformLanguagePreference = 'system'): string {
 const t = (key: Parameters<typeof platformText>[1]) => platformText(locale, key)
 return platformPage(t('Instance recovery'), `<h1>${t('Instance recovery')}</h1><p>${t('Restart your instance while keeping your configuration, plugins, conversations and files.')}</p>
<p>${t('Running tasks and terminal commands will be interrupted. Other members keep working.')}</p>
<form id="restart"><label><input type="checkbox" required> ${t('I understand that my running tasks will be interrupted')}</label>
<button type="submit">${t('Restart instance')}</button></form><p id="status" role="status" aria-live="polite"></p>
<nav><a id="return" href="/enter">${t('Return to DSH')}</a><form action="/logout" method="post"><button>${t('Log out')}</button></form></nav>`, `
document.getElementById('restart').addEventListener('submit',async event=>{
 event.preventDefault();const button=event.currentTarget.querySelector('button');const status=document.getElementById('status');
 button.disabled=true;status.textContent=${JSON.stringify(t('Restarting your instance…'))};
 try{const response=await fetch('/recovery/restart',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmed:true})});
 const result=await response.json();if(!response.ok){const errors=${JSON.stringify(locale === 'en' ? {} : Object.fromEntries(Object.keys(zhErrorMessages).map(code => [code, platformError(locale, { code, error: '' })])))};throw new Error(errors[result.code]||result.error||${JSON.stringify(t('Restart failed'))})};
 status.textContent=${JSON.stringify(t('Instance restarted. Your saved data is ready.'))};document.getElementById('return').href=result.entry;
 }catch(error){status.textContent=${JSON.stringify(t('Restart failed. {error} You can retry or ask an administrator to reset your DSH environment.'))}.replace('{error}',()=>error.message)}
 finally{button.disabled=false}
});
`, undefined, locale, preference)
}
export const COMMUNITY_RECOVERY_PAGE = communityRecoveryPage()
