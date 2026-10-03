import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'

// A fake GitHub I/O port: persists refs/releases/bytes, independent of release policy.
const root = process.env.RELEASE_FIXTURE_ROOT
const statePath = join(root, 'state.json')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { refs: [], releases: [] }
const args = process.argv.slice(2)
const option = name => args[args.indexOf(name) + 1]
const release = () => state.releases.find(item => item.tag_name === args[2])
const save = () => writeFileSync(statePath, JSON.stringify(state))
if (args[0] === 'api') {
  const path = args[1]
  if (path.includes('/git/matching-refs/')) console.log(JSON.stringify(state.refs.filter(item => item.ref.startsWith(`refs/tags/${path.split('/').at(-1)}`))))
  else if (path.endsWith('/git/refs')) {
    const fields = args.filter((_, index) => args[index - 1] === '-f')
    const field = name => fields.find(item => item.startsWith(`${name}=`)).slice(name.length + 1)
    const item = { ref: field('ref'), object: { type: 'commit', sha: field('sha') } }
    state.refs.push(item); save(); console.log(JSON.stringify(item))
  } else if (path.includes('/releases?')) console.log(JSON.stringify(state.releases))
  else console.log(JSON.stringify(state.releases.find(item => item.id === Number(path.split('/').at(-1)))))
} else if (args[0] === 'release') {
  if (args[1] === 'create') {
    state.releases.push({ id: state.releases.length + 1, tag_name: args[2], draft: true, prerelease: args.includes('--prerelease'), assets: [] }); save()
  } else if (args[1] === 'upload') {
    const source = args[3], name = basename(source)
    if (process.env.RELEASE_FIXTURE_FAIL_ASSET === name) { console.error('injected interrupted upload'); process.exit(1) }
    const destination = join(root, args[2]); mkdirSync(destination, { recursive: true }); copyFileSync(source, join(destination, name))
    release().assets.push({ id: release().assets.length + 1, name }); save()
  } else if (args[1] === 'download') {
    copyFileSync(join(root, args[2], option('--pattern')), join(option('--dir'), option('--pattern')))
  } else if (args[1] === 'edit') { release().draft = false; save() }
  else throw new Error('Unsupported release operation')
} else throw new Error('Unsupported GitHub operation')
