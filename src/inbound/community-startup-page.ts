import { platformText, platformError, platformErrorMessages } from '../domain/platform-copy.js'
import type { PlatformLocale } from '../domain/platform-language.js'
import { PLATFORM_THEME_SCRIPT } from '../domain/platform-theme.js'

/** Independent boot surface: no DSH assets are requested before the carrier is ready. */
export function communityStartupPage(locale: PlatformLocale, getNavigation: boolean): string {
  const t = (key: Parameters<typeof platformText>[1]) => platformText(locale, key)
  const copy = { preparing: t('Preparing plugins and skills'), starting: t('Starting your workspace'), connecting: t('Connecting…'),
    failure: t('Your workspace could not start.'), interrupted: t('The connection was interrupted. Try restarting your instance.') }
  const errors = Object.fromEntries(Object.keys(platformErrorMessages.en).map(code => [code, platformError(locale, { code, error: '' })]))
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HARNESS</title>
<style>
:root{color-scheme:light;--bg:#fff;--fg:#0f1115;--muted:#6b7280;--line:#e5e7eb}
:root[data-theme=dark]{color-scheme:dark;--bg:#151517;--fg:#f9fafb;--muted:#9ca3af;--line:#37373d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{min-height:100svh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 24px;text-align:center}
.brand{font-size:16px;font-weight:600;letter-spacing:.08em;margin:0 0 24px}.spinner{width:20px;height:20px;border:2px solid var(--line);border-top-color:var(--fg);border-radius:50%;animation:spin .9s linear infinite;margin-bottom:16px}
p{font-size:12px;line-height:18px;margin:0;max-width:32rem;overflow-wrap:anywhere}#slow{color:var(--muted);margin-top:8px}#failure{max-width:32rem;margin-top:20px}label{display:flex;align-items:flex-start;gap:8px;text-align:left;font-size:12px;line-height:18px;margin:16px 0}input{margin:2px 0 0;flex-shrink:0}button,a{font:inherit;font-size:12px;color:var(--fg)}button{border:1px solid var(--line);background:transparent;padding:9px 16px;border-radius:6px;cursor:pointer}button:disabled{opacity:.5;cursor:default}a{display:block;margin-top:16px;text-underline-offset:3px}[hidden]{display:none!important}:focus-visible{outline:2px solid currentColor;outline-offset:3px}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none;border-style:dotted}}
</style><script>${PLATFORM_THEME_SCRIPT}</script></head><body><main data-platform-startup><div class="brand">HARNESS</div><div class="spinner" aria-hidden="true"></div><p id="stage" role="status" aria-live="polite">${copy.preparing}</p><p id="slow" hidden>${t('The first startup may take a few minutes.')}</p>
<section id="failure" hidden><form id="restart"><label><input type="checkbox" required>${t('I understand that my running tasks will be interrupted')}</label><button>${t('Restart instance')}</button></form><a href="/recovery">${t('More recovery options')}</a></section></main><script>
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
</script></body></html>`
}
