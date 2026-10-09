import type { CommunityGroupView } from '../../src/domain/admin-contract';
import type { PlatformMessageKey } from '../../src/domain/platform-copy';
export function communityGroupLabel(group: CommunityGroupView, t: (key: PlatformMessageKey) => string): string {
  if (group.id === 'default' && group.name === 'Default group') return t('Default group');
  if (group.kind === 'admin' && group.name === 'Administrators') return t('Administrators');
  return group.name;
}
