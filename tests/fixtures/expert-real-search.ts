import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileText } from '../../src/adapters/runtime-command.js'

export const realExpertSearchPackage = '@example/expert-real-search'
export const realExpertSearchTool = 'expert_anysearch_domains'
/** An insert-only plugin; the platform supplies its authenticated upstream endpoint. */
export async function packRealExpertSearch(root: string): Promise<string> {
  const directory = join(root, 'real-search-package'); await mkdir(directory)
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: realExpertSearchPackage, version: '1.0.0', type: 'module', dsh: { bundle: { patch: './patch.yml' } } }))
  await writeFile(join(directory, 'patch.yml'), JSON.stringify([{ insert: [{ id: 'search', name: './search.mjs' }] }]))
  await writeFile(join(directory, 'search.mjs'), `export const name='expert-real-search';export const inject=['tools'];export function apply(ctx,config){ctx.tools.register({name:'${realExpertSearchTool}',description:'Read the actual AnySearch domain catalog for planning a marketing task.',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async()=>{const response=await fetch(config.endpoint.replace(/\\/$/,'')+'/v1/domains',{headers:{authorization:'Bearer '+config.apiKey}});if(!response.ok)throw Error('upstream denied '+response.status);const catalog=await response.json();if(catalog.code!==0||!catalog.data)throw Error('upstream business response failed');return {status:'ANYSEARCH_DOMAINS_READY',upstreamStatus:response.status,catalog}}})}`)
  const packed = JSON.parse(await execFileText('npm', ['pack', directory, '--ignore-scripts', '--json', '--pack-destination', root])) as { filename: string }[]
  return join(root, packed[0]!.filename)
}
