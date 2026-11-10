import type { InitialModelView } from '../domain/admin-contract.js'
import type { PlatformLanguagePreference, PlatformLocale } from '../domain/platform-language.js'
import { platformText } from '../domain/platform-copy.js'
import { communityProviderProtocols } from '../domain/shared-models.js'
import { loginIntroduction } from './platform-login-style.js'
import { htmlText, platformPage } from './platform-page.js'
import { initialModelScript } from './initial-model-script.js'

export function initialModelPage(view: InitialModelView, locale: PlatformLocale, preference: PlatformLanguagePreference): string {
  const t = (key: Parameters<typeof platformText>[1]) => htmlText(platformText(locale, key))
  const { defaults, settings } = view
  const saved = settings.providers.length > 0
  const protocolNames = {
    'anthropic-messages': 'Anthropic Messages',
    'openai-completions': 'OpenAI Chat Completions',
    'openai-responses': 'OpenAI Responses',
  } as const
  const field = (name: string, label: string, value: string | undefined, maxlength: number) =>
    `<label>${label}<input name="${name}" value="${htmlText(value ?? '')}" maxlength="${maxlength}" required></label>`
  const form = saved
    ? ''
    : `${field('name', t('Provider name'), defaults.name, 128)}<label>${t('Protocol')}<select name="apiFormat" aria-label="${t('Protocol')}">${communityProviderProtocols.map(protocol => `<option value="${protocol}"${protocol === (defaults.apiFormat ?? 'openai-completions') ? ' selected' : ''}>${t(protocolNames[protocol])}</option>`).join('')}</select></label><label id="base-url-label"><span id="base-url-title"></span><input name="baseUrl" value="${htmlText(defaults.baseUrl ?? '')}" type="url" required></label><p id="base-url-hint" class="setup-hint"></p><label>${t('API key')}<input name="apiKey" type="password" autocomplete="new-password"${defaults.apiKey.configured ? '' : ' required'}></label>${defaults.apiKey.configured ? `<p class="setup-hint">${t('Preset key: ••••••••')}<br>${t('A key is preset on the server. Leave this field empty to keep it, or enter a replacement.')}</p>` : ''}${field('model', t('Model identifier {index}').replace('{index}', '1'), defaults.model, 256)}`
  return platformPage(
    t('Configure your first model'),
    `<div class="setup-step" data-step="3">${t('Step {current} of {total}').replace('{current}', '3').replace('{total}', '3')}</div><h1>${t('Configure your first model')}</h1><p>${t('Add one shared provider and model now, or configure them later in Model management.')}</p>${view.defaultsStatus === 'invalid' ? `<p role="alert">${t('Initialization defaults could not be read. Enter the settings manually or skip this step.')}</p>` : ''}<form id="initial-model-form" class="setup-form" data-saved="${saved}"><input type="hidden" name="revision" value="${settings.revision}">${form}${saved ? `<p>${t('Configuration is already saved. You can retry publication without creating another provider.')}</p>` : ''}<button type="submit">${t(saved ? 'Retry model publication' : 'Save model configuration and finish installation')}</button></form><p id="model-status" role="status"></p><button type="button" class="setup-complete" id="model-continue">${t(saved ? 'Continue to administration' : 'Skip for now and finish installation')}</button><p class="setup-hint">${t('More providers, models and advanced options are available in Model management.')}</p>`,
    initialModelScript(locale),
    { className: 'login-page setup-page', introduction: loginIntroduction(locale) },
    locale,
    preference,
  )
}
