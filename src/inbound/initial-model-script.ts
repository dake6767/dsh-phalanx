import { platformError, platformText } from '../domain/platform-copy.js'
import type { PlatformLocale } from '../domain/platform-language.js'

export function initialModelScript(locale: PlatformLocale): string {
  const t = (key: Parameters<typeof platformText>[1]) => platformText(locale, key)
  const errors = Object.fromEntries(
    ['provider-invalid', 'provider-protocol-invalid', 'model-revision-conflict', 'model-projection-pending', 'sign-in-required', 'admin-required'].map(code => [
      code,
      platformError(locale, { code, error: '' }),
    ]),
  )
  const protocols = {
    'anthropic-messages': [t('Messages Base URL'), t('Use the provider’s Messages prefix. The platform appends /v1/messages.')],
    'openai-completions': [
      t('Chat Completions Base URL'),
      t('Use the provider’s Chat Completions prefix, usually ending in /v1. The platform appends /chat/completions.'),
    ],
    'openai-responses': [t('Responses Base URL'), t('Use the provider’s Responses prefix, usually ending in /v1. The platform appends /responses.')],
  }
  return `
const form = document.getElementById('initial-model-form'), status = document.getElementById('model-status'), next = document.getElementById('model-continue');
const errors = ${JSON.stringify(errors)}, protocols = ${JSON.stringify(protocols)};
next.addEventListener('click', () => location.assign('/admin'));
let busy = false;
function updateProtocol() {
 const choice = protocols[form.elements.apiFormat.value];
 document.getElementById('base-url-title').textContent = choice[0];
 document.getElementById('base-url-hint').textContent = choice[1];
}
if (form.elements.apiFormat) { form.elements.apiFormat.addEventListener('change', updateProtocol); updateProtocol(); }
form.addEventListener('submit', async event => {
 event.preventDefault(); if (busy) return;
 const data = Object.fromEntries(new FormData(form)); data.revision = Number(data.revision);
 busy = true; form.querySelector('button').disabled = true; status.textContent = '';
 try {
  const response = await fetch('/admin/api/initial-model', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) {
   if (result.code === 'model-projection-pending' || result.code === 'model-revision-conflict') {
    // Reload only the committed public state; never replay a create with a new identity.
    const current = await fetch('/admin/api/initial-model');
    if (current.ok && (await current.json()).settings.providers.length) { location.reload(); return; }
   }
   throw Error(errors[result.code] || ${JSON.stringify(t('Request failed'))});
  }
  if (form.elements.apiKey) form.elements.apiKey.value = '';
  form.hidden = true;
  status.textContent = ${JSON.stringify(t('Configuration saved. The model has not been tested.'))};
  next.textContent = ${JSON.stringify(t('Continue to administration'))}; next.focus();
 } catch (error) { status.textContent = error.message; }
 finally { busy = false; form.querySelector('button').disabled = false; }
});
`
}
