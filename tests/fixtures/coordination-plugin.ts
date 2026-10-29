import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileText } from '../../src/adapters/runtime-command.js'

export const coordinationPackage = '@example/coordination-client'
/** A portable client bundle using the same documented closure-factory seam as the platform. */
export async function packCoordinationPlugin(root: string): Promise<string> {
  const directory = join(root, 'coordination-package')
  await mkdir(directory)
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: coordinationPackage,
      version: '1.0.0',
      type: 'module',
      main: './index.js',
      exports: { '.': './index.js', './client': './client.js' },
      dsh: { bundle: { patch: './patch.yml' }, client: { platform: 'web', inject: [] } },
    }),
  )
  await writeFile(join(directory, 'index.js'), "export const name='coordination-client'; export function apply() {}\n")
  await writeFile(join(directory, 'patch.yml'), JSON.stringify([{ insert: [{ id: 'coordination-client', name: coordinationPackage }] }]))
  await writeFile(
    join(directory, 'client.js'),
    `window.__ModuleLoader__.load({id:${JSON.stringify(coordinationPackage)},factory:()=>({name:'coordination-client',apply(ctx){ctx.effect(()=>{const marker=document.createElement('div');marker.dataset.coordinationClient='ready';marker.hidden=true;document.body.appendChild(marker);return()=>marker.remove()})}})});`,
  )
  const packed = JSON.parse(await execFileText('npm', ['pack', directory, '--ignore-scripts', '--json', '--pack-destination', root])) as { filename: string }[]
  return join(root, packed[0]!.filename)
}
