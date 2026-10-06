/** Shared presentation values for the independent platform pages and management UI. */
export const PLATFORM_THEME_CSS = `
:root,.light,[data-theme="light"]{color-scheme:light;--accent:oklch(.49 .105 158);--accent-foreground:oklch(.99 0 0);--background:oklch(.975 .003 155);--foreground:oklch(.25 .015 155);--surface:oklch(1 0 0);--surface-foreground:var(--foreground);--muted:oklch(.51 .015 155);--border:oklch(.88 .01 155);--field-background:var(--surface);--field-foreground:var(--foreground)}
.dark,[data-theme="dark"]{color-scheme:dark;--accent:oklch(.72 .13 158);--accent-foreground:oklch(.19 .025 155);--background:oklch(.18 .008 155);--foreground:oklch(.93 .006 155);--surface:oklch(.23 .01 155);--surface-foreground:var(--foreground);--muted:oklch(.7 .012 155);--border:oklch(.35 .014 155);--field-background:var(--surface);--field-foreground:var(--foreground)}
`
export const PLATFORM_THEME_SCRIPT = `(()=>{
const key='dsh-phalanx.appearance.v1';let preference='system';
try{const saved=localStorage.getItem(key);if(['light','dark','system'].includes(saved))preference=saved}catch{}
const media=matchMedia('(prefers-color-scheme: dark)');
const apply=()=>{document.documentElement.dataset.appearance=preference;const theme=preference==='system'?(media.matches?'dark':'light'):preference;document.documentElement.dataset.theme=theme;document.documentElement.classList.toggle('dark',theme==='dark');document.documentElement.classList.toggle('light',theme==='light');document.querySelectorAll('[data-appearance]').forEach(select=>{select.value=preference})};
document.addEventListener('change',event=>{if(event.target.matches('[data-appearance]')){preference=event.target.value;try{localStorage.setItem(key,preference)}catch{}apply()}});
addEventListener('storage',event=>{if(event.key===key){preference=['light','dark','system'].includes(event.newValue)?event.newValue:'system';apply()}});
media.addEventListener('change',apply);document.addEventListener('DOMContentLoaded',apply);apply();
})()`
