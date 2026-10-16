import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { imageInputs } from './image-inputs.mjs'
import { imageName } from './integrity.mjs'
import { supportsImageReuse } from './image-reuse.mjs'
import { registryDigest } from './registry.mjs'

const [output, ...args] = process.argv.slice(2)
let origin = 'https://ghcr.io', platform = 'linux/amd64', force = false, rehearsal = false
while (args.length) {
  const flag = args.shift()
  if (flag === '--force-rebuild') force = true
  else if (flag === '--reuse-rehearsal') rehearsal = true
  else if (flag === '--registry-origin' && args[0]) origin = args.shift()
  else if (flag === '--platform' && args[0]) platform = args.shift()
  else throw Error('Usage: select-image.mjs OUTPUT [--platform PLATFORM] [--force-rebuild] [--reuse-rehearsal] [--registry-origin URL]')
}
if (!output) throw Error('An image selection output path is required')
const inputs = await imageInputs('.', { platform, nodeImage: process.env.DSH_PHALANX_BUILD_NODE_IMAGE })
const version = JSON.parse(await readFile('package.json', 'utf8')).version
const policy = JSON.parse(await readFile('release-policy.json', 'utf8'))
const supported = supportsImageReuse(version, policy.compatibility)
let reason = platform !== 'linux/amd64' ? 'development-platform' : force ? 'forced' : !supported && !rehearsal ? 'legacy-baseline' : 'not-found'
const digest = reason === 'not-found' ? await registryDigest(imageName, `input-${inputs.inputHash}`, { anonymous: true, origin }) : undefined
if (digest) reason = 'input-match'
const selection = { ...inputs, mode: digest ? 'reuse' : 'build', reason, rehearsal,
  ...(digest ? { digest, reference: `${imageName}@${digest}` } : {}) }
await writeFile(output, JSON.stringify(selection, null, 2) + '\n')
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `mode=${selection.mode}\ninput_hash=${inputs.inputHash}\nreference=${selection.reference ?? ''}\n`)
console.log(JSON.stringify(selection))
