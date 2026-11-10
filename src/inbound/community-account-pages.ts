import { communityBootstrapScript } from './community-bootstrap-script.js'
import { platformText } from '../domain/platform-copy.js'
import type { PlatformLocale, PlatformLanguagePreference } from '../domain/platform-language.js'
import { loginIntroduction } from './platform-login-style.js'
import { htmlText, pageError, platformPage } from './platform-page.js'
import type { SignedInAccountView } from '../domain/admin-contract.js'

const avatarInitial = (username: string): string => htmlText(username.trim().charAt(0).toUpperCase() || '?')

const accountTag = (locale: PlatformLocale, admin: boolean): string =>
  admin ? `<span class="account-tag">${platformText(locale, 'Administrator')}</span>` : ''

/** One remembered account row: choosing enters that account, more actions hold removal. */
export function accountChoiceRow(locale: PlatformLocale, account: SignedInAccountView): string {
  const t = (key: Parameters<typeof platformText>[1]) => platformText(locale, key)
  const identity = `<span class="account-avatar" aria-hidden="true">${avatarInitial(account.username)}</span><span class="account-name">${htmlText(account.username)}${accountTag(locale, account.admin)}</span>`
  const removeForm = `<form method="post" action="/account/signed-in/remove"><input type="hidden" name="marker" value="${htmlText(account.marker)}"><button type="submit" class="account-remove" title="${t('Remove from this browser')}">${t('Remove')}</button></form>`
  const main =
    account.status === 'available'
      ? `<form class="account-select" method="post" action="/account/switch"><input type="hidden" name="marker" value="${htmlText(account.marker)}"><button type="submit">${identity}</button></form>`
      : account.status === 'reauthentication-required'
        ? `<a class="account-select" href="/login?username=${encodeURIComponent(account.username)}">${identity}</a><span class="account-status">${t('Sign in again')}</span>`
        : account.status === 'current'
          ? `<a class="account-select" href="${account.admin ? '/admin' : '/'}">${identity}</a><span class="account-status">${t('Current account')}</span>`
          : `<span class="account-select">${identity}</span><span class="account-status">${t('Unavailable')}</span>`
  const trailing =
    account.status === 'unavailable'
      ? removeForm
      : `<details class="account-more"><summary aria-label="${t('More actions')}" title="${t('More actions')}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M5 12h.01M12 12h.01M19 12h.01"/></svg></summary><div role="menu">${removeForm}</div></details>`
  return `<li class="account-item${account.status === 'unavailable' ? ' unavailable' : ''}">${main}${trailing}</li>`
}

/** Static forms never include submitted values or deployment credentials; remembered accounts and a prefilled username are chosen page states. */
export function communityLoginPage(
  error?: string,
  locale: PlatformLocale = 'en',
  preference: PlatformLanguagePreference = 'system',
  accounts: readonly SignedInAccountView[] = [],
  prefillUsername?: string,
  hasRememberedAccounts = false,
): string {
  const t = (key: Parameters<typeof platformText>[1]) => platformText(locale, key)
  const prefill = prefillUsername === undefined ? '' : ` value="${htmlText(prefillUsername)}"`
  const form = `<form method="post" action="/login"><label>${t('Username')}<input name="username" autocomplete="username"${prefill}${prefillUsername === undefined ? ' autofocus' : ''} required></label><label>${t('Password')}<input name="password" type="password" autocomplete="current-password" required${prefillUsername === undefined ? '' : ' autofocus'}></label><button type="submit">${t('Sign in')} <span aria-hidden="true">→</span></button></form><p class="login-help">${t('Need an account? Contact your administrator.')}</p>`
  const content =
    accounts.length === 0
      ? `<p class="entry-eyebrow">${t('YOUR WORKSPACE AWAITS')}</p><h1>${t('Sign in to dsh-phalanx')}</h1><p>${t('Use the account provided by your administrator.')}</p>${pageError(error)}${form}${hasRememberedAccounts ? `<p><a href="/login?accounts=1">${t('Choose an account')}</a></p>` : ''}`
      : `<p class="entry-eyebrow">${t('YOUR WORKSPACE AWAITS')}</p><h1>${t('Choose an account')}</h1><p>${t('Accounts you signed in to on this browser.')}</p>${pageError(error)}<ul class="account-list">${accounts.map(account => accountChoiceRow(locale, account)).join('')}</ul><div class="account-list-actions"><a class="account-other" href="/login?other=1">${t('Use another account')}</a><form method="post" action="/account/signed-in/remove-all"><button type="submit" class="account-remove-all">${t('Sign out of all accounts')}</button></form></div>`
  return platformPage(
    accounts.length === 0 ? t('Sign in') : t('Choose an account'),
    content,
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
    `<p class="entry-eyebrow">${t('FIRST-TIME SETUP')}</p><h1>${t('Create the first administrator')}</h1>${pageError(error)}<p id="instructions">${t('Open the initialization link printed by the installer to create your administrator account.')}</p><section id="bootstrap-content"></section>`,
    communityBootstrapScript(locale),
    { className: 'login-page setup-page', introduction: loginIntroduction(locale) },
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
    `<p class="entry-eyebrow">${t('FIRST-TIME SETUP')}</p><h1>${t('Initialization unavailable')}</h1><p>${t('The initialization endpoint is closed.')}</p><a class="setup-link" href="/login">${t('Sign in')} <span aria-hidden="true">→</span></a>`,
    '',
    { className: 'login-page', introduction: loginIntroduction(locale) },
    locale,
    preference,
  )
}
export const COMMUNITY_BOOTSTRAP_CLOSED_PAGE = communityBootstrapClosedPage()

/** Account creation is shown after the database selection has been committed and activated. */
export function communityAdministratorForm(locale: PlatformLocale): string {
  const t = (key: Parameters<typeof platformText>[1]) => platformText(locale, key)
  return `<div class="setup-step" data-step="2">${t('Step {current} of {total}').replace('{current}', '2').replace('{total}', '3')}</div><h2>${t('Administrator account')}</h2><p class="setup-lead">${t('Choose your administrator username and password.')} ${t('This account manages members, groups and shared tools.')}</p><form method="post" action="/bootstrap" class="setup-form"><input name="credential" type="hidden"><label>${t('Username')}<input name="username" autocomplete="username" required autofocus></label><label>${t('Password')}<input name="password" type="password" autocomplete="new-password" required></label><div class="setup-actions"><button type="submit">${t('Create administrator')} <span aria-hidden="true">→</span></button></div></form>`
}
