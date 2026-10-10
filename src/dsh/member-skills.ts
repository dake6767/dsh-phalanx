import { join } from 'node:path'
import { dshHomePath } from './profile-layout.js'
export const memberSkillsMount = '/dsh-phalanx/member-skills'
export const memberSkillsPackage = '@deepseek-ai/dsh-skill-filesystem'
export const memberSkillsContainerModule = `/opt/dsh/node_modules/${memberSkillsPackage}/lib/index.js`

/** Public skill-filesystem configuration in its own platform include layer. */
export function memberSkillsConfiguration(directory: string, module: string) {
  return {
    entries: [{ id: 'phalanx-skills', name: module, config: { providerName: 'phalanx-skills', includeDefaultRoots: false, customSkillDirs: [join(directory, 'live')], watch: true } }],
    overlay: [{ insert: [{ id: 'phalanx-skills-layer', name: '@deepseek-ai/cordis-plugin-include', config: { path: join(directory, 'entries.json') } }] }, { id: 'phalanx-skills-layer', disabled: false }],
  }
}

export function memberDefaultSkillRoots(home: string) { return [join(dshHomePath(home), 'skills'), join(home, '.agents', 'skills')] }
