import { LOGIN_INTRODUCTION } from './platform-login-style.js'
import { pageError, platformPage } from './platform-page.js'
/** Static forms never include submitted values or deployment credentials. */
export function communityLoginPage(error?: string): string {
  return platformPage('Sign in', `<p class="entry-eyebrow">YOUR WORKSPACE AWAITS</p><h1>Sign in to dsh-phalanx</h1><p>Use the account provided by your administrator.</p>${pageError(error)}<form method="post" action="/login"><label>Username<input name="username" autocomplete="username" required autofocus></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in <span aria-hidden="true">→</span></button></form><p class="login-help">Need an account? Contact your administrator.</p>`, '', { className: 'login-page', introduction: LOGIN_INTRODUCTION })
}
export function communityBootstrapPage(error?: string): string {
  return platformPage('Create the first administrator', `<h1>Create the first administrator</h1>${pageError(error)}<p id="instructions">Open the initialization link printed by the installer to create your administrator account.</p><form method="post" action="/bootstrap" hidden><input name="credential" type="hidden"><label>Username<input name="username" autocomplete="username" required autofocus></label><label>Password<input name="password" type="password" autocomplete="new-password" required></label><button type="submit">Create administrator</button></form>`, `
function applyCredential() {
const credential = new URLSearchParams(location.hash.slice(1)).get('credential');
document.querySelector('[name="credential"]').value = '';
document.querySelector('form').hidden = true;
document.getElementById('instructions').textContent = 'Open the initialization link printed by the installer to create your administrator account.';
if (credential && /^[A-Za-z0-9_-]{43}$/.test(credential)) {
 document.querySelector('[name="credential"]').value = credential;
 document.querySelector('form').hidden = false;
 document.getElementById('instructions').textContent = 'Choose your administrator username and password.';
} else if (credential) { document.getElementById('instructions').textContent = 'This initialization link is invalid. Use the current link printed by the installer.'; }
}
addEventListener('hashchange', applyCredential); applyCredential();
`)
}
export const COMMUNITY_LOGIN_PAGE = communityLoginPage()
export const COMMUNITY_BOOTSTRAP_PAGE = communityBootstrapPage()
export const COMMUNITY_BOOTSTRAP_CLOSED_PAGE = platformPage('Initialization unavailable', '<h1>Initialization unavailable</h1><p>The initialization endpoint is closed.</p><a href="/login">Sign in</a>')
