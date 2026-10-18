import type { SuiteCatalogArch, SuiteCatalogArchValue, SuiteCatalogDownload, SuiteCatalogRuntimeDependencyItem } from './suite-catalog-document.js'

/** The platform renders declarative downloads into the preparation command; catalog bytes never carry commands. */
export type SuiteCatalogPrepareCommands = Readonly<Partial<Record<SuiteCatalogArch, string>>>

const architectures: readonly SuiteCatalogArch[] = ['amd64', 'arm64']
const archToken = (architecture: SuiteCatalogArch): string => architecture
const nodeArchToken = (architecture: SuiteCatalogArch): string => architecture === 'amd64' ? 'x64' : 'arm64'
const substitute = (value: string, architecture: SuiteCatalogArch): string =>
  value.replaceAll('{arch}', archToken(architecture)).replaceAll('{nodeArch}', nodeArchToken(architecture))
const archValue = (value: string | SuiteCatalogArchValue | undefined, architecture: SuiteCatalogArch): string | undefined =>
  typeof value === 'string' ? substitute(value, architecture) : value?.[architecture] === undefined ? undefined : substitute(value[architecture]!, architecture)
const dirname = (path: string): string | undefined => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined

/** Browser downloads use the architecture-specific Playwright host variable, mirroring the download source. */
const browserHostVariable = (architecture: SuiteCatalogArch): string => architecture === 'arm64' ? 'PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST' : 'PLAYWRIGHT_DOWNLOAD_HOST'

const curl = (url: string, target: string, download: SuiteCatalogDownload): string => {
  const timeouts = download.timeout === undefined ? ''
    : `${download.timeout.connectSeconds === undefined ? '' : ` --connect-timeout ${download.timeout.connectSeconds}`}${download.timeout.totalSeconds === undefined ? '' : ` --max-time ${download.timeout.totalSeconds}`}`
  return `curl --fail --location --silent --show-error${timeouts} "${url}" -o ${target}`
}

const extraction = (download: SuiteCatalogDownload, target: string): readonly string[] => {
  const extract = download.extract
  if (!extract || extract.format === 'none') return []
  if (extract.format === 'tar') {
    const strip = extract.stripComponents === undefined ? '' : ` --strip-components=${extract.stripComponents}`
    const directory = extract.directory === undefined ? '' : ` -C ${extract.directory}`
    const member = extract.member === undefined ? '' : ` ${extract.member}`
    return [`tar xzf ${target}${strip}${directory}${member}`, `rm ${target}`]
  }
  return [`unzip -q ${target}${extract.directory === undefined ? '' : ` -d ${extract.directory}`}`, `rm ${target}`]
}

/**
 * Generates one preparation command per architecture.
 * Ordering is fixed so the four base-field 0.1.19 entries prepare exactly as their 0.1.18 definitions did:
 * registry installs in place, downloaded files with their checksum, extraction after the checksum, then entry links.
 */
export function suitePrepareCommands(item: SuiteCatalogRuntimeDependencyItem): SuiteCatalogPrepareCommands {
  const commands: Partial<Record<SuiteCatalogArch, string>> = {}
  for (const architecture of architectures) {
    const lines: string[] = ['set -eu']
    const directories = new Set<string>()
    const mkdir = (...wanted: (string | undefined)[]): void => {
      const missing = wanted.filter((directory): directory is string => directory !== undefined && !directories.has(directory))
      if (!missing.length) return
      for (const directory of missing) directories.add(directory)
      lines.push(`mkdir -p ${missing.join(' ')}`)
    }
    let complete = true
    for (const download of item.downloads) {
      if (download.source === 'npm' || download.source === 'pypi') {
        const packages = download.packages!.map(spec => substitute(spec, architecture))
        lines.push(download.source === 'npm'
          ? `npm install --prefix "$RD_OUT" --ignore-scripts --no-audit --no-fund ${packages.join(' ')}`
          : `python3 -m pip install --disable-pip-version-check --no-input --prefix "$RD_OUT" ${packages.join(' ')}`)
        continue
      }
      const url = archValue(download.url, architecture)
      const sha256 = download.sha256?.[architecture]
      if (url === undefined || sha256 === undefined || download.target === undefined) { complete = false; break }
      const target = download.target
      if (download.extract === undefined || download.extract.format === 'none') mkdir(dirname(target))
      const source = download.source === 'github-assets' ? `\${GITHUB_ASSETS_PREFIX}${url}` : `\${${browserHostVariable(architecture)}:-https://cdn.playwright.dev}/${url}`
      lines.push(curl(source, target, download), `echo "${sha256}  ${target}" | sha256sum -c -`)
      const extracts = download.extract !== undefined && download.extract.format !== 'none'
      if (extracts) mkdir(download.extract!.directory, item.entry === undefined ? undefined : item.paths[0])
      lines.push(...extraction(download, target))
      if (download.executable === true) lines.push(`chmod +x ${target}`)
    }
    const entry = archValue(item.entry, architecture)
    if (entry !== undefined) {
      const directory = item.paths[0]
      if (directory === undefined || item.commands[0] === undefined) { complete = false; break }
      mkdir(directory)
      lines.push(`ln -s ../${entry} ${directory}/${item.commands[0]}`)
    }
    if (complete) commands[architecture] = lines.join('\n')
  }
  return commands
}

/** Render the executable check as a platform command string; arguments are data. */
export function suitePrepareCheckCommand(item: SuiteCatalogRuntimeDependencyItem): string | undefined {
  return item.check === undefined ? undefined : `${item.check.command}${item.check.args?.length ? ` ${item.check.args.join(' ')}` : ''}`
}
