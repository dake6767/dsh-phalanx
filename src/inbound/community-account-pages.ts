import { communityBootstrapScript } from './community-bootstrap-script.js'
import { platformText } from '../domain/platform-copy.js'
import type { PlatformLocale, PlatformLanguagePreference } from '../domain/platform-language.js'
import { loginIntroduction } from './platform-login-style.js'
import { pageError, platformPage } from './platform-page.js'
/** Static forms never include submitted values or deployment credentials. */
export function communityLoginPage(error?: string, locale: PlatformLocale = 'en', preference: PlatformLanguagePreference = 'system'): string {
  const t = (key: Parameters<typeof platformText>[1]) => platformText(locale, key)
  return platformPage(
    t('Sign in'),
    `<p class="entry-eyebrow">${t('YOUR WORKSPACE AWAITS')}</p><h1>${t('Sign in to dsh-phalanx')}</h1><p>${t('Use the account provided by your administrator.')}</p>${pageError(error)}<form method="post" action="/login"><label>${t('Username')}<input name="username" autocomplete="username" required autofocus></label><label>${t('Password')}<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">${t('Sign in')} <span aria-hidden="true">→</span></button></form><p class="login-help">${t('Need an account? Contact your administrator.')}</p>`,
    '',
    { className: 'login-page', introduction: loginIntroduction(locale) },
    locale,
    preference,
  )
}
export function communityBootstrapPage(error?: string, locale: PlatformLocale = 'en', preference: PlatformLanguagePreference = 'system'): string {
  const t = (key: Parameters<typeof platformText>[1]) => platformText(locale, key)
  return platformPage(
    t('Create the first administrator'),
    `<h1>${t('Create the first administrator')}</h1>${pageError(error)}<p id="instructions">${t('Open the initialization link printed by the installer to create your administrator account.')}</p><section id="bootstrap-content"></section>`,
    communityBootstrapScript(locale),
    undefined,
    locale,
    preference,
  )
}
export const COMMUNITY_LOGIN_PAGE = communityLoginPage()
export const COMMUNITY_BOOTSTRAP_PAGE = communityBootstrapPage()
export function communityBootstrapClosedPage(locale: PlatformLocale = 'en', preference: PlatformLanguagePreference = 'system'): string {
  const t = (key: Parameters<typeof platformText>[1]) => platformText(locale, key)
  return platformPage(
    t('Initialization unavailable'),
    `<h1>${t('Initialization unavailable')}</h1><p>${t('The initialization endpoint is closed.')}</p><a href="/login">${t('Sign in')}</a>`,
    '',
    undefined,
    locale,
    preference,
  )
}
export const COMMUNITY_BOOTSTRAP_CLOSED_PAGE = communityBootstrapClosedPage()

/** Account creation is shown after the database selection has been committed and activated. */
export function communityAdministratorForm(locale: PlatformLocale): string {
  const t = (key: Parameters<typeof platformText>[1]) => platformText(locale, key)
  return `<p>${t('Choose your administrator username and password.')}</p><form method="post" action="/bootstrap"><input name="credential" type="hidden"><label>${t('Username')}<input name="username" autocomplete="username" required autofocus></label><label>${t('Password')}<input name="password" type="password" autocomplete="new-password" required></label><button type="submit">${t('Create administrator')}</button></form>`
}
