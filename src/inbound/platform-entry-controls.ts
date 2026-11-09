import { platformLanguageCookie, type PlatformLanguagePreference } from '../domain/platform-language.js'

// Sun, moon and monitor outlines match the management header controls on the 24px grid.
const appearances = [
  [
    'light',
    'Light',
    'M12 3v2M12 19v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M3 12h2M19 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  ],
  ['dark', 'Dark', 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z'],
  ['system', 'System appearance', 'M3 5h18v11H3zM8 20h8M12 16v4'],
] as const
const languages = ['system', 'en', 'zh-CN'] as const
const glyph = (path: string) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`
const globe = 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.6 9h16.8M3.6 15h16.8M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18'

type Translate = (key: 'Appearance' | 'Light' | 'Dark' | 'System appearance' | 'Platform language' | 'System') => string

/** Server-rendered pages reuse the management header: an appearance toggle and a language menu in the top-right corner. */
export function entryControls(t: Translate, preference: PlatformLanguagePreference): string {
  const label = (value: (typeof languages)[number]) => (value === 'system' ? t('System') : value === 'en' ? 'English' : '简体中文')
  const toggle = appearances
    .map(
      ([value, key, path]) =>
        `<button type="button" data-appearance-choice="${value}" aria-label="${t(key)}" title="${t(key)}" aria-pressed="false">${glyph(path)}</button>`,
    )
    .join('')
  const options = languages
    .map(
      value =>
        `<button type="button" role="menuitemradio" data-language-choice="${value}" aria-checked="${value === preference}">${label(value)}${glyph('M20 6 9 17l-5-5')}</button>`,
    )
    .join('')
  const cookies = JSON.stringify(Object.fromEntries(languages.map(value => [value, platformLanguageCookie(value)])))
  return `<div class="entry-controls"><div class="entry-appearance" role="toolbar" aria-label="${t('Appearance')}">${toggle}</div><details class="entry-language"><summary aria-label="${t('Platform language')}: ${label(preference)}">${glyph(globe)}<span>${label(preference)}</span>${glyph('m6 9 6 6 6-6')}</summary><div role="menu" aria-label="${t('Platform language')}">${options}</div></details></div><script>(()=>{const sync=()=>{const value=window.dshPhalanxAppearance?.get()??'system';document.querySelectorAll('[data-appearance-choice]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.appearanceChoice===value)))};document.querySelectorAll('[data-appearance-choice]').forEach(button=>button.addEventListener('click',()=>window.dshPhalanxAppearance?.set(button.dataset.appearanceChoice)));addEventListener('dsh-phalanx:appearance',sync);sync();const menu=document.querySelector('.entry-language');document.addEventListener('click',event=>{if(menu.open&&!menu.contains(event.target))menu.open=false});document.addEventListener('keydown',event=>{if(event.key==='Escape'&&menu.open){menu.open=false;menu.querySelector('summary').focus()}});const cookies=${cookies};document.querySelectorAll('[data-language-choice]').forEach(button=>button.addEventListener('click',()=>{document.cookie=cookies[button.dataset.languageChoice];const navigation=document.createElement('form');navigation.method='get';navigation.action=location.pathname+location.hash;for(const [name,value] of new URLSearchParams(location.search)){const input=document.createElement('input');input.type='hidden';input.name=name;input.value=value;navigation.append(input)}document.body.append(navigation);navigation.submit()}))})()</script>`
}

export const ENTRY_CONTROLS_CSS = `
.entry-controls{position:fixed;top:16px;right:clamp(16px,3vw,32px);z-index:5;display:flex;align-items:center;gap:8px}
.entry-appearance{display:inline-flex;gap:2px;padding:2px;border-radius:calc(var(--radius) * 3);background:var(--default)}
.entry-appearance button{width:28px;height:28px;display:grid;place-items:center;margin:0;padding:0;border:0;border-radius:calc(var(--radius) * 3 - 2px);background:transparent;color:var(--muted);cursor:pointer}
.entry-appearance button:hover{background:transparent;color:var(--foreground)}
.entry-appearance button[aria-pressed=true]{background:var(--surface);color:var(--foreground);box-shadow:0 1px 2px #0000001a,0 0 1px #0000001f}
.entry-language{position:relative}
.entry-language summary{display:flex;align-items:center;gap:6px;height:32px;padding:0 10px;border-radius:calc(var(--radius) * 3);color:var(--muted);font-size:14px;font-weight:500;list-style:none;cursor:pointer;user-select:none}
.entry-language summary::-webkit-details-marker{display:none}
.entry-language summary:hover,.entry-language[open] summary{background:var(--default);color:var(--foreground)}
.entry-language summary svg:last-child{width:14px;height:14px;opacity:.7}
.entry-language [role=menu]{position:absolute;right:0;top:calc(100% + 6px);min-width:160px;display:grid;padding:4px;border:1px solid var(--separator);border-radius:calc(var(--radius) * 3);background:var(--overlay);box-shadow:0 8px 24px #0000001f,0 1px 2px #0000000f}
.entry-language [role=menu] button{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;height:auto;margin:0;padding:8px 10px;border:0;border-radius:calc(var(--radius) * 2);background:transparent;color:var(--foreground);font-size:14px;font-weight:400;text-align:left}
.entry-language [role=menu] button:hover{background:var(--default)}
.entry-language [role=menu] button svg{opacity:0}
.entry-language [role=menu] button[aria-checked=true] svg{opacity:1;color:var(--accent)}
.login-page .entry-language summary{color:var(--muted)}
@media(max-width:760px){.entry-controls{top:14px;right:16px}.entry-language summary span{display:none}.login-page .entry-appearance{background:var(--brand-panel-line)}.login-page .entry-appearance button,.login-page .entry-language summary{color:var(--brand-panel-muted)}.login-page .entry-appearance button[aria-pressed=true]{background:color-mix(in oklab,var(--brand-panel-foreground) 18%,transparent);color:var(--brand-panel-foreground);box-shadow:none}.login-page .entry-language summary:hover,.login-page .entry-language[open] summary{background:var(--brand-panel-line);color:var(--brand-panel-foreground)}}
`
