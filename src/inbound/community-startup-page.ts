import { platformText, platformError, platformErrorMessages } from '../domain/platform-copy.js'
import type { PlatformLocale } from '../domain/platform-language.js'
import { communityWaitingPage } from './community-waiting-page.js'

/** Independent boot surface: no DSH assets are requested before the carrier is ready. */
export function communityStartupPage(locale: PlatformLocale, getNavigation: boolean): string {
  const t = (key: Parameters<typeof platformText>[1]) => platformText(locale, key)
  const copy = {
    preparing: t('Preparing plugins and skills'),
    starting: t('Starting your workspace'),
    connecting: t('Connecting…'),
    failure: t('Your workspace could not start.'),
    interrupted: t('The connection was interrupted. Try restarting your instance.'),
  }
  const errors = Object.fromEntries(Object.keys(platformErrorMessages.en).map(code => [code, platformError(locale, { code, error: '' })]))
  return communityWaitingPage({
    locale,
    surface: 'startup',
    content: `<p id="stage" role="status" aria-live="polite">${copy.preparing}</p><p id="slow" hidden>${t('The first startup may take a few minutes.')}</p>
<section id="failure" hidden><form id="restart"><label><input type="checkbox" required>${t('I understand that my running tasks will be interrupted')}</label><button>${t('Restart instance')}</button></form><a href="/recovery">${t('More recovery options')}</a></section>`,
    script: `
(()=>{
const copy=${JSON.stringify(copy)},errors=${JSON.stringify(errors)},stage=document.getElementById('stage'),slow=document.getElementById('slow'),failure=document.getElementById('failure'),spinner=document.querySelector('.spinner'),form=document.getElementById('restart'),button=form.querySelector('button');
let pollTimer,slowTimer,restarting=false,stopped=false;
const clear=()=>{clearTimeout(pollTimer);clearTimeout(slowTimer)};
const fail=code=>{stopped=true;clear();spinner.hidden=true;slow.hidden=true;stage.textContent=errors[code]||copy.failure;failure.hidden=false};
const enter=()=>{clear();${getNavigation ? 'location.reload()' : "history.replaceState(null,'',location.href);location.reload()"}};
const poll=async()=>{if(stopped)return;try{const response=await fetch('/account/startup',{cache:'no-store'});if(stopped)return;if(response.status===401){clear();location.replace('/login');return}if(!response.ok)throw new Error();const result=await response.json();if(stopped)return;if(result.state==='ready'){if(!restarting){enter();return}}else if(result.state==='failed'){if(!restarting){fail(result.code);return}}else if(Object.hasOwn(copy,result.state)){stage.textContent=copy[result.state]}}catch{if(!restarting){fail('');stage.textContent=copy.interrupted;return}}if(!stopped)pollTimer=setTimeout(poll,1000)};
const begin=()=>{stopped=false;spinner.hidden=false;failure.hidden=true;slow.hidden=true;stage.textContent=copy.preparing;slowTimer=setTimeout(()=>{slow.hidden=false},15000);void poll()};
form.addEventListener('submit',async event=>{event.preventDefault();clear();restarting=true;button.disabled=true;begin();try{const response=await fetch('/recovery/restart',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmed:true})});const result=await response.json();if(!response.ok){fail(result.code);return}enter()}catch{fail('');stage.textContent=copy.interrupted}finally{restarting=false;button.disabled=false}});
addEventListener('pagehide',()=>{stopped=true;clear()},{once:true});begin();
})();
`,
  })
}
