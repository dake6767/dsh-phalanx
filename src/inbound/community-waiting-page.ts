import type { PlatformLocale } from '../domain/platform-language.js'
import { PLATFORM_THEME_SCRIPT } from '../domain/platform-theme.js'

/** Shared independent HTML surface; templates deliberately keep static CSS together. */
export function communityWaitingPage({
  locale,
  surface,
  content,
  script,
}: {
  readonly locale: PlatformLocale
  readonly surface: 'startup' | 'maintenance'
  readonly content: string
  readonly script: string
}): string {
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HARNESS</title>
<style>
:root{color-scheme:light;--bg:#fff;--fg:#0f1115;--muted:#6b7280;--line:#e5e7eb}
:root[data-theme=dark]{color-scheme:dark;--bg:#151517;--fg:#f9fafb;--muted:#9ca3af;--line:#37373d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{min-height:100svh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 24px;text-align:center}
.brand{font-size:16px;font-weight:600;letter-spacing:.08em;margin:0 0 24px}.spinner{width:20px;height:20px;border:2px solid var(--line);border-top-color:var(--fg);border-radius:50%;animation:spin .9s linear infinite;margin-bottom:16px}
p{font-size:12px;line-height:18px;margin:0;max-width:32rem;overflow-wrap:anywhere}#slow{color:var(--muted);margin-top:8px}#failure{max-width:32rem;margin-top:20px}label{display:flex;align-items:flex-start;gap:8px;text-align:left;font-size:12px;line-height:18px;margin:16px 0}input{margin:2px 0 0;flex-shrink:0}button,a{font:inherit;font-size:12px;color:var(--fg)}button{border:1px solid var(--line);background:transparent;padding:9px 16px;border-radius:6px;cursor:pointer}button:disabled{opacity:.5;cursor:default}a{display:block;margin-top:16px;text-underline-offset:3px}[hidden]{display:none!important}:focus-visible{outline:2px solid currentColor;outline-offset:3px}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none;border-style:dotted}}
</style><script>${PLATFORM_THEME_SCRIPT}</script></head><body><main data-platform-${surface}><div class="brand">HARNESS</div><div class="spinner" aria-hidden="true"></div>${content}</main><script>${script}</script></body></html>`
}
