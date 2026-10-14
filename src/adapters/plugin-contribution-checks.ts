import type { ContributionDeclaration, ContributionFinding } from '../domain/member-contribution.js'
import type { PluginContributionInspection } from '../domain/plugin-contribution.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import { pluginContributionFindings } from '../domain/plugin-contribution-checks.js'
import { ContributionCheckError } from '../domain/contribution-check-error.js'
import { YamlPluginAccessSyntax } from './plugin-access-syntax.js'

/** Interpret exported package metadata only; archives remain inside the preparation container. */
export class PluginContributionChecks {
  check(declaration: ContributionDeclaration | undefined, prepared: PreparedPlugin, inspection: PluginContributionInspection, retainWarnings: boolean): readonly ContributionFinding[] {
    const plugin = declaration?.plugin ?? { upstreams: [], environment: [], entriesYaml: '' }
    const findings = [...inspection.findings, ...pluginContributionFindings(plugin, prepared, new YamlPluginAccessSyntax())]
    for (const name of inspection.installScripts ?? []) findings.push({ code: 'contribution-plugin-install-script', severity: 'warning', path: `package.json.scripts.${name}`, advice: 'The platform installs with --ignore-scripts. Remove or replace required install steps, or retain this warning after verifying offline activation.' })
    const declared = new Set(plugin.upstreams.map(row => new URL(row.baseUrl).hostname.toLowerCase()))
    for (const host of inspection.externalHosts ?? []) if (!declared.has(host) && !['registry.npmjs.org', 'localhost', '127.0.0.1', 'example.test', 'example.com'].includes(host)) findings.push({ code: 'contribution-plugin-domain', severity: 'warning', path: host, advice: 'Declare a platform upstream and reference {upstream:name} for external requests, or explain why this public address does not need platform credentials.' })
    if (findings.some(row => row.severity === 'reject') || findings.length && !retainWarnings) throw new ContributionCheckError(findings)
    return findings
  }
}
