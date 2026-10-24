import type { PlatformMessageKey } from '../../src/domain/platform-copy';

export const suiteKindLabels = { 'runtime-dependency': 'Runtime dependencies', 'skill': 'Skills', 'skill-pack': 'Skill pack', 'execution': 'Delegated execution', 'plugin': 'Plugins' } as const satisfies Record<string, PlatformMessageKey>;
