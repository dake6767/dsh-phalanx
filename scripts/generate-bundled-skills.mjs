import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { parse } from 'yaml'
const source = process.argv[2]
if (!source) throw new Error('Usage: node scripts/generate-bundled-skills.mjs <official-runtime-checkout>')
const revision = JSON.parse(readFileSync(new URL('../runtime-versions.json', import.meta.url), 'utf8')).dsh.revision
const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' })
const paths = git('ls-tree', '-r', '--name-only', revision).split('\n').filter(path => /^packages\/[^/]+\/[^/]+\/(skills|assets)\/[^/]+\/SKILL\.md$/u.test(path))
if (!paths.length) throw new Error('No bundled skills found in the fixed runtime')
const names = paths.map(path => {
 const text = git('show', `${revision}:${path}`), match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)
 if (!match) throw new Error(`Invalid skill metadata: ${path}`)
 const name = parse(match[1]).name
 if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) throw new Error(`Invalid skill name: ${path}`)
 return name
}).sort()
writeFileSync(new URL('../src/dsh/bundled-skills.ts', import.meta.url), `// Generated from shipped SKILL.md metadata; regenerate when runtime-versions.json changes.\nexport const bundledSkillRevision = '${revision}'\nexport const bundledSkillNames: readonly string[] = ${JSON.stringify([...new Set(names)], null, 2)}\n`)
