import type { ContributionRepositories } from '../ports/contribution-unit-of-work.js'
import type { PluginAccessSyntaxPort } from '../ports/plugin-access.js'
import type { LibraryPlugin } from '../domain/plugin-library.js'
import type { ContributionSetup, MemberContribution } from '../domain/member-contribution.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { pluginGroupRevision } from '../domain/plugin-group-revision.js'
import { readyRuntimeDependencies } from '../domain/runtime-dependency-selection.js'
import { PluginAccessAdministration } from './plugin-access-administration.js'
import { PluginUpstreamAdministration } from './plugin-upstream-administration.js'
import { PluginContributionAdministration } from './plugin-contribution-administration.js'

/** Prechecked artifacts stay outside SQL; all plugin adoption facts use these bound repositories. */
export async function applyPluginContributionFacts(
  rows: ContributionRepositories,
  plugin: LibraryPlugin,
  contribution: MemberContribution,
  syntax: PluginAccessSyntaxPort,
  setup?: ContributionSetup,
): Promise<readonly string[]> {
  await rows.plugins.lock(plugin.packageName, plugin.revision ?? 'none')
  readyRuntimeDependencies(await rows.runtime.list(), plugin.runtimeDependencies ?? [])
  const library = await rows.plugins.list(),
    accounts = await rows.accounts.list(),
    groups = await rows.accounts.listGroups(),
    warnings: string[] = [],
    selected: string[] = []
  for (const choice of setup?.groups ?? []) {
    const group = groups.find(group => group.id === choice.id && group.kind === 'ordinary')
    if (!group) {
      warnings.push('A selected group was removed; its plugin grant was not applied.')
      continue
    }
    const preinstalled = await rows.pluginGrants.preinstalls(group.id)
    if (preinstalled.includes(plugin.packageName)) {
      warnings.push('A selected group now preinstalls this plugin; its controlled grant was not applied.')
      continue
    }
    if (choice.revision !== pluginGroupRevision(group, await rows.pluginGrants.get(group.id), preinstalled, library, accounts))
      throw new BusinessRuleError('conflict', 'Review the affected group again.', 'plugin-impact-changed')
    selected.push(group.id)
  }
  await rows.plugins.save(plugin, plugin.revision ?? 'none')
  // Both ordinary upstream edits and this unit acquire parent then header before reading the plan's settings.
  await rows.pluginUpstreams.lock(plugin.packageName)
  const access = new PluginAccessAdministration(rows.accounts, rows.plugins, rows.pluginAccess, rows.pluginUpstreams, syntax),
    upstreams = new PluginUpstreamAdministration(rows.accounts, rows.plugins, rows.pluginUpstreams, access),
    administration = new PluginContributionAdministration(access, upstreams, syntax),
    configurationWarnings = await administration.apply(contribution, setup),
    receipt = { id: contribution.id, revision: contribution.revision }
  warnings.push(...configurationWarnings)
  if (!configurationWarnings.length) {
    for (const id of selected) {
      if (!rows.pluginGrants.grantContribution) throw Error('Contribution grants require bound receipt storage')
      await rows.pluginGrants.grantContribution(id, plugin.packageName, receipt)
    }
    if (setup?.published === true) {
      const current = (await rows.plugins.list()).find(row => row.packageName === plugin.packageName)!
      if ((await rows.pluginUpstreams.list(plugin.packageName)).some(row => !!row.credential) && setup.credentialSharingConfirmed !== true) {
        const message = 'Platform credentials changed during adoption. Confirm credential sharing before publishing this plugin.'
        warnings.push(message)
        await rows.plugins.save({ ...current, contributionPublicationReceipt: { ...receipt, warnings: [message] } })
      } else {
        if (!current.published && !current.restorePublication) await rows.pluginSelections.removePackage(plugin.packageName)
        await rows.plugins.save({ ...current, published: true, restorePublication: false, contributionPublicationReceipt: receipt })
      }
    }
  }
  const current = (await rows.plugins.list()).find(row => row.packageName === plugin.packageName)!
  await rows.plugins.save({ ...current, contributionDistributionReceipt: { ...receipt, ...(warnings.length ? { warnings } : {}) } })
  return warnings
}
