# Stable authenticated user-space entry

Status: accepted

Member entry uses the account's persisted opaque space ID at
`/app/<spaceId>/`. Login and the old root redirect there. Administrators keep
`/admin` and enter their own DSH through the same space path.

The ID identifies storage; it grants no access. Each HTTP request and WebSocket
upgrade checks the signed session against the current account and space before
starting or forwarding to DSH. Retired identities cannot access a replacement
account's runtime. Existing storage mappings and IDs survive ordinary restart.

The proxy strips only the admitted prefix and scopes every DSH Set-Cookie to it.
HTTPS deployments add Secure. Official DSH `--public-url` supplies the advertised
browser mount. A protected plugin uses the public WebServer index tap to enable
credentialed manifest requests. Official DSH owns plugin resources, RPC, WebSocket
and manifest behavior. Launch-token exchange
and model requests retain private loopback transports. No DSH source is modified.

DSH's shell and index query/hash bookmarks remain supported within the mount;
in-page navigation keeps relative RPC under its document base. This adds no new
DSH session route or router. Unknown native resources keep DSH's normal response.
