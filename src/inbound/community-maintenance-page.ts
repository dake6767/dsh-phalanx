import { createHash } from 'node:crypto'
import { platformText } from '../domain/platform-copy.js'
import type { PlatformLocale } from '../domain/platform-language.js'
import { communityWaitingPage } from './community-waiting-page.js'

/** The same standalone page is served by the platform and its installed upgrade listener. */
export function communityMaintenancePage(locale: PlatformLocale): string {
  const page = communityWaitingPage({
    locale,
    surface: 'maintenance',
    content: `<p role="status" aria-live="polite">${platformText(locale, 'System upgrade in progress')}</p><p id="slow">${platformText(locale, 'This page will refresh automatically when the system is ready.')}</p>`,
    script: `(()=>{
let stopped=false,timer;
const poll=async()=>{try{const response=await fetch('/readyz',{cache:'no-store'});if(!stopped&&response.ok){location.reload();return}}catch{}if(!stopped)timer=setTimeout(poll,3000)};
addEventListener('pagehide',()=>{stopped=true;clearTimeout(timer)},{once:true});timer=setTimeout(poll,3000);
})();`,
  })
  // Static hashes travel inside the installed HTML, so both servers apply the same policy.
  const hashes = (tag: string) =>
    Array.from(
      page.matchAll(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'gu')),
      match => "'sha256-" + createHash('sha256').update(match[1]!).digest('base64') + "'",
    ).join(' ')
  const policy = `default-src 'none'; script-src ${hashes('script')}; style-src ${hashes('style')}; connect-src 'self'; base-uri 'none'`
  return page.replace('<meta charset="utf-8">', `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}">`)
}
