import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileText } from '../../src/adapters/runtime-command.js'

export const expertFixturePackage = '@example/expert-tools'
export async function packExpertPlugin(
  root: string,
  kind: 'healthy' | 'local' | 'core' | 'sync' | 'async' | 'import' | 'dependent',
): Promise<{ archive: string; packageName: string }> {
  const packageName = kind === 'local' ? expertFixturePackage : kind === 'healthy' ? expertFixturePackage : '@example/expert-' + kind
  const directory = join(root, 'package-' + kind)
  await mkdir(directory)
  const service = 'expertFixture' + (kind === 'core' ? 'Core' : 'Shared')
  const entries =
    kind === 'healthy' || kind === 'local' || kind === 'core'
      ? [
          { id: 'provider', name: './provider.mjs' },
          { id: 'consumer', name: './consumer.mjs', config: { label: 'base', nested: { preserved: true } } },
        ]
      : [{ id: 'main', name: './plugin.mjs' }]
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: packageName, version: '1.0.0', type: 'module', dsh: { bundle: { patch: './patch.yml' } } }),
  )
  await writeFile(join(directory, 'patch.yml'), JSON.stringify([...(kind === 'core' ? [{ id: 'web', config: {} }] : []), { insert: entries }]))
  await writeFile(
    join(directory, 'provider.mjs'),
    `export const name='expert-fixture-provider';export function apply(ctx){ctx.provide('${service}',{marker:'${kind === 'local' ? 'LOCAL_COPY' : 'PLATFORM_COPY'}'})}`,
  )
  await writeFile(
    join(directory, 'consumer.mjs'),
    `export const name='expert-fixture-consumer';export const inject=['tools','${service}'];export function apply(ctx,config){ctx.tools.register({name:'expert_fixture_remote',description:'Expert fixture upstream',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async()=>{if(!config.endpoint)return {marker:ctx.${service}.marker};const result=await fetch(config.endpoint,{headers:{authorization:'Bearer '+config.apiKey}});if(!result.ok)throw Error('upstream denied '+result.status);return {marker:ctx.${service}.marker,remote:await result.json(),label:config.label,nested:config.nested}}})}`,
  )
  const failure =
    kind === 'sync' ? "throw Error('controlled sync failure')" : kind === 'async' ? "await Promise.resolve();throw Error('controlled async failure')" : ''
  await writeFile(
    join(directory, 'plugin.mjs'),
    `${kind === 'import' ? "if(process.env.FAIL_EXPERT)await import('./missing.mjs');" : ''}export const name='expert-fixture-${kind}';export const inject=${kind === 'dependent' ? "process.env.FAIL_EXPERT?['expertFailureFixture']:[]" : '[]'};export ${kind === 'async' ? 'async ' : ''}function apply(ctx){if(process.env.FAIL_EXPERT){${failure}}${kind === 'sync' ? "ctx.provide('expertFailureFixture',{ready:true});" : ''}}`,
  )
  const packed = JSON.parse(await execFileText('npm', ['pack', directory, '--ignore-scripts', '--json', '--pack-destination', root])) as { filename: string }[]
  return { archive: join(root, packed[0]!.filename), packageName }
}
