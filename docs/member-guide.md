# Member guide

[简体中文](member-guide.zh-CN.md) · [Installation](install.md) · [Operations](operations.md) · [Administrator guide](admin-guide.md)

## Enter DSH and use Platform App Center

Sign in with the member account your administrator created. The platform opens your personal DSH space at `/app/<spaceId>/`. Projects, conversations and workspace files belong to that space. Use the native model picker to choose from enabled shared models. If you cannot enter DSH, go to `/recovery`.

When your group shows **Platform App Center**, open it from the DSH sidebar. The **Plugins**, **Skills** and **MCP services** tabs show the resources you can use. The app center follows the language set in DSH. Login, recovery and the management console use the browser's platform language.

- Choose **Install** on a published plugin to get a native copy or a shared-key selection, as indicated on the row. A platform-controlled plugin loads read-only. Native copies remain manageable in the native plugin settings. A same-name copy independently installed in DSH stays there.
- On an eligible platform-delivered native copy, **Update available** or **Content update available** shows the available target. Choose **Update plugin**, wait for the result, then restart DSH if prompted. Library updates do not automatically update member copies. If a settings error is shown, read the status before choosing **Apply service settings**, **Retry service setup** or restarting the instance. Personal settings can stay in use.
- Choose the skills or packs you need. Group-preinstalled skills are read-only. An individual skill uploaded into your own skill directory may take precedence over the platform copy. The app center shows when an override is present.
- Enable the MCP services you need. A service required by a group grant stays enabled while that grant applies. Optional services can be disabled and personal selections can be removed. MCP tools refresh on the next agent request. Your own MCP configuration is kept when a same-name platform service takes precedence.

If an administrator enabled voice input, start or restart your instance to receive it. Use a secure browser context (HTTPS remotely or localhost) and allow the browser to use the microphone. For platform web search, ask an administrator to configure the platform search key. Your shared model key is not used for that setting.

## Switching accounts in this browser

Administrators see **Go to admin console** as the first item in the DSH sidebar
account menu. It opens the same deployment's `/admin` home in a new tab and keeps
DSH open. Ordinary members do not see this item. Refresh DSH after a role change
to update the menu; management pages always check the current permission.

Choose **Switch accounts** in the DSH sidebar account menu or the management
sidebar account area. The recovery page at `/recovery` also lists accounts,
even when DSH cannot start. Select an available account to enter its default
page: management for administrators, DSH for members.

- **Add account** opens the login page. Sign in once with that account's username
  and password to remember it in this browser. Canceling or failing login keeps
  the current account. The browser remembers at most ten accounts; remove one
  before adding another when full. Signing in to an existing entry updates it.
- **Remove** forgets an entry in this browser; it does not delete the platform
  account. For available entries, open the row's more-actions menu. Unavailable
  entries show **Remove** directly and cannot be selected.
- **Sign out** ends the current browser login and keeps its entry as **Sign in
  again**. The login page offers other available accounts; **Use another
  account** opens the login form. **Sign out of all accounts** clears the
  remembered list and the current browser login.

Each login still lasts twelve hours. Switching does not renew it. Expired or
revoked sessions require a password again; disabled or deleted accounts are
unavailable. Recreating a deleted username does not reconnect its old entry.
The list belongs to this browser and does not synchronize across devices.

One browser has one current account. After a switch, other open tabs display
a blocking account-change notice and disconnect their old live connections.
Choose **Go** to enter the current account. Different tabs cannot remain active
as different accounts.

**Switching accounts clears DSH's local browser storage without confirmation.**
Unsent messages, unfinished answers to agent questions, custom shortcuts,
sidebar layout, manual conversation ordering, and editor and shell preferences
are lost. Running tasks, agent questions and saved conversations remain in the
account's instance; switch back to continue. The platform's **System**, **Light**
or **Dark** appearance preference survives switching. This browser preference
is independent of DSH's theme.

## Downloading artifacts

Delivery cards and document preview toolbars provide **Download**. The browser
saves the current original file, including formats that cannot be previewed;
it does not save an Office preview PDF in place of its source. Chinese filenames
are preserved. Older conversation references follow the current file at that
path, without keeping historical snapshots.

Downloads require the member's current login and a valid Session. Files must
remain within that member's private home or the Session workspace and pass the
native file permissions. Missing or unreadable files show a local error. Large
files stream in bounded chunks; a file changed during transfer causes the
browser download to fail, so refresh and retry after writing has finished.

## Interactive HTML files

HTML and HTM files open with script interaction enabled, independently of **Show
coding view**. Buttons, local form events and DOM updates work in a sandboxed
preview. Reopening or reloading the file resets its in-memory state.

File previews support self-contained documents: scripts cannot read the platform
page or its login credentials. Resource loading and API requests are restricted by
a Content Security Policy; this is not a guarantee against all network navigation.
Persistent storage, external resources and application correctness are not guaranteed. Use a running HTTP service for an
application that needs a server; opening a file does not provide saved application
data or service hosting.

## Office preview fonts

The user-instance image includes Noto CJK (`1:20220127+repack1-1`),
Liberation 2 (`2.1.5-1`), Carlito (`20220224-1`), and Caladea (`20200211-1`)
from Debian Bookworm. These fonts use the SIL Open Font License 1.1; their
copyright and license notices remain in `/usr/share/doc/<package>/copyright`
inside the image. The official Office converter reads the system font
directories and retains its default family substitutions. Missing document
fonts still appear in the native preview notice; substitution can change layout.

Previewing never rewrites the original Office file. Restarting the instance
after an image upgrade creates a new converter generation, so reopening an
existing file uses the new fonts instead of a PDF cached by the old converter.
There is no font upload or font management page. Spreadsheet previews retain
DSH's native spreadsheet renderer.

## Personal skill keys

Backups of your files may contain personal keys, tokens and plugin settings. Keep exported files and backups private. Secrets saved by a native plugin are not automatically encrypted in the platform database.

Configure a third-party key in a private file in your own space, outside DSH's
resettable configuration files. Create it in your terminal with mode `0600`; do not
paste a real key into a conversation or shared archive. For example, store
`EXAMPLE_API_KEY='your-personal-key'` in `~/.config/my-skill/secrets.env`.
Your scripts can read this personal file.

DSH does not automatically pass parent variables whose names contain `KEY` to its
bash tool. Merely saving `.env` or a DSH credential is insufficient. Explicitly
load the private file **inside each DSH bash invocation**, then execute the script
relative to the resource directory returned when loading the skill:

```sh
set -a
. "$HOME/.config/my-skill/secrets.env"
set +a
cd /path/returned/when/loading/the/skill
python3 scripts/example.py
```

Replace the variable name, resource path and arguments with those required by the
skill. When the administrator enables [platform execution](skill-execution.md),
configured commands use platform credentials without requiring a personal copy.

## Member logout and recovery

The protected platform plugin supplies **Log out**, **Restart instance** and **More recovery options** in DSH’s sidebar account menu. Logout clears this browser’s platform login while accepted tasks continue. Restart requires confirmation that running tasks will be interrupted; **Return to DSH** reopens the same space with configuration, user plugins, conversations and files retained.

Valid member credentials still sign in to the platform when DSH fails to start and lead directly to recovery. If DSH cannot load, open `/recovery` at your deployment origin to log out or restart and see the result. Use **More recovery options** to open the same recovery page from the account menu. Its **Reset DSH environment** section backs up and resets your DSH configuration and self-installed plugins, while preserving projects, conversations and other personal files. Confirm that tasks will be interrupted and those settings will be reset. Member requests are limited to once every ten minutes, including failed attempts and across platform restarts; administrators are exempt. Contact an administrator to recover an older configuration. The platform selects the current authenticated account as the target. The protected platform plugin and controlled or shared-credential read-only plugins cannot be disabled or uninstalled through ordinary plugin management. Native member copies remain manageable. Manual terminal access and adding native plugins are available when enabled for your group.
