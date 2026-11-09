# dsh-phalanx admin UI design

Updated: 2026-11-06. Applies to the admin app in `admin-ui/src` and the server-rendered
entry pages in `src/inbound` (sign in, account chooser, first-run setup, recovery).

Phalanx surfaces inside native DSH follow the separate
[DSH integration design](../docs/dsh-ui/DESIGN.md), using DSH primitives and theme tokens.
(user-confirmed)

## Direction
A quiet operations console: white panels on a light gray page, one accent blue for
selection and primary actions, compact type. Closer to a well-kept settings app than a
marketing site. (inferred)

## Brand assets (keep)
- Stacked-layers mark (`brand` in `admin-ui/src/CommunityIcon.tsx`), used only for the logo. (user-confirmed)
- Accent blue `--accent` and the dark brand panel `--brand-panel` on entry pages. (inferred)

## Semantic roles
Tokens live in `src/domain/platform-theme.ts`; admin-only tokens in `admin-ui/src/community.css`.
- `--accent`: primary buttons, current nav item, selected list row, focus. Never decorative fills. (inferred)
- `--surface` / `--background`: panels and cards are surface; the page behind them is background. (inferred)
- `--default`: tab tracks, segmented controls, hover fills. Do not repaint it to change cards or buttons; it also drives tabs. (user-confirmed)
- `--admin-light-border`: card and secondary-button borders in the light theme, softer than `--border`. (user-confirmed)
- `--admin-card-tint`: the faint blue gradient on library cards, light theme only. (user-confirmed)
- `--success-ink` / `--warning-ink` / `--danger-ink`: status text on light backgrounds. (inferred)
- Type: topbar page name 14px, page h1 18px, panel title 15px, body 13–14px, meta 12px. (user-confirmed)
- Shape: radii derive from `--radius`; panels `* 3`, cards `* 2.5`, rows `* 2`. (inferred)

## Layout
- Sidebar 230px (216px below 1080px). Content fills the window; no max width. (user-confirmed)
- Topbar and content share one horizontal inset; topbar title, h1, tabs and panels start on the same left edge. (user-confirmed)
- Page heading: h1 + one muted line on the left, at most two actions on the right, vertically centered, 32px buttons. (user-confirmed)
- Stacked sections inside a tab are separated by a 16px gap, never touching. (user-confirmed)

## Light theme surfaces (user-confirmed)
- Cards and `secondary`/`tertiary` buttons: white with a soft gray border, not gray fills.
- Library cards add a faint top-left blue gradient and a light shadow; hover deepens both slightly.
- Dark theme keeps its current filled surfaces.

## Available components
Use these before writing new markup.
- Page shell: `.page-heading`, then `.panel.plugin-library-panel` with `.panel-filter-header`
  (title + count, one-line description, filter on the right) and `.panel-footer.plugin-library-note` for the policy note.
- Library cards: `.library-compact-grid` > `.plugin-library-card`. Title row, `.plugin-summary-meta`
  ("source · version"), two-line description, footer with status chips left and one or two 26px actions right.
  The whole card opens details through `.plugin-details-action`. Warnings are `.plugin-card-error` text plus a chip, never a message box.
- Workspace tabs: `.skill-library-tabs.library-workspace-tabs`.
- Drawers: [`admin-ui/src/CommunityDialog.tsx`](src/CommunityDialog.tsx) with `drawer`; body is
  `.plugin-settings-panel` > `.plugin-detail-section`. The header shows the title once; no eyebrow, no repeated identity.
- Bordered section with optional action: [`admin-ui/src/CommunityGrantSection.tsx`](src/CommunityGrantSection.tsx).
- Grants: [`admin-ui/src/CommunityGrantList.tsx`](src/CommunityGrantList.tsx), a granted list plus an "Add" picker.
- Dependency choice: [`admin-ui/src/CommunityDependencyPicker.tsx`](src/CommunityDependencyPicker.tsx), title-only checkboxes.
- Fields: [`admin-ui/src/CommunityField.tsx`](src/CommunityField.tsx) and [`admin-ui/src/CommunitySelect.tsx`](src/CommunitySelect.tsx) with the default variant.
- Icons: [`admin-ui/src/CommunityIcon.tsx`](src/CommunityIcon.tsx); nav icons are mapped once in `navIcons` in `admin-ui/src/CommunityAdminApp.tsx`.
- Entry pages: [`src/inbound/platform-entry-controls.ts`](../src/inbound/platform-entry-controls.ts) for the top-right appearance and language controls; [`src/inbound/platform-login-style.ts`](../src/inbound/platform-login-style.ts) for the two-column layout.

## Sample pages
Values and structure follow these files.
- Plugin library: `admin-ui/src/CommunityPluginsPage.tsx` (cards, drawer opening on Basic settings).
- Group details: `admin-ui/src/CommunityGroupDetails.tsx` (drawer sections, grant lists).
- Models: `admin-ui/src/CommunityModelsPanel.tsx` (selected provider row: accent tint, inset bar).
- System settings: `admin-ui/src/CommunitySystemSettingsPage.tsx` (four tabs, aligned update card).
- Entry pages: `src/inbound/community-account-pages.ts`.

## User choices (2026-11-06, user-confirmed)
- Lists of selectable rows read like the sidebar: plain rows; the selected row gets an accent tint and a 3px left bar.
- Sidebar actions (switch account, open DSH) are icon + text rows, not buttons; user info sits last; "Open {name}'s DSH" opens a new tab.
- No count bubbles in navigation or tabs.
- The top bar does not repeat the signed-in user.
- Every nav item has its own icon.
- Usage records: one filter row plus "More filters"; summaries show the top 5.
- Plugin details open on Basic settings.
- Small facts such as versions are a muted line, not gray tiles.

## Don't
- Global element rules (`input`, `button`, `:focus-visible`) outside a layer. Customize through tokens or BEM classes.
- `variant="secondary"` on fields; it paints gray fills that clash with white panels.
- Native `<select>` in the admin app; use `CommunitySelect`.
- `CommunityMessage` boxes inside compact cards.
- Gray filled blocks for short facts, or repeating the drawer title as an eyebrow.
