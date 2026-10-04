/** Static forms never include submitted values or deployment credentials. */
const HEAD = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
const STYLE = '<style>body{font:16px system-ui;background:#f5f6f8;color:#19232d;margin:0}main{max-width:420px;margin:10vh auto;padding:32px;background:white;border:1px solid #d8dee5;border-radius:12px}label{display:block;margin:18px 0}input{display:block;box-sizing:border-box;width:100%;padding:10px;margin-top:6px;border:1px solid #adb8c4;border-radius:6px}button{padding:10px 18px;background:#175b48;color:white;border:0;border-radius:6px;cursor:pointer}a{color:#175b48}</style>'
export const COMMUNITY_LOGIN_PAGE = `${HEAD}<title>Sign in to dsh-phalanx</title>${STYLE}</head><body><main><h1>Sign in to dsh-phalanx</h1><form method="post" action="/login"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form></main></body></html>`
export const COMMUNITY_BOOTSTRAP_PAGE = `${HEAD}<meta name="referrer" content="same-origin"><title>Create the first administrator</title>${STYLE}</head><body><main><h1>Create the first administrator</h1><p id="instructions">Open the initialization link printed by the installer to create your administrator account.</p><form method="post" action="/bootstrap" hidden><input name="credential" type="hidden"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="new-password" required></label><button type="submit">Create administrator</button></form></main><script>
const credential = new URLSearchParams(location.hash.slice(1)).get('credential');
if (credential && /^[A-Za-z0-9_-]{43}$/.test(credential)) {
  document.querySelector('[name="credential"]').value = credential;
  document.querySelector('form').hidden = false;
  document.getElementById('instructions').textContent = 'Choose your administrator username and password.';
}
</script></body></html>`
