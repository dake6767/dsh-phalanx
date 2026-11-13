/** Reads the actual installed release and protected configuration, including a frozen predecessor's default. */
export async function installedUserDataRoot(remote: (command: string) => Promise<string>): Promise<string> {
  const script = `from pathlib import Path
import json,os,re,shlex
values={}
for line in Path('/etc/dsh-phalanx/environment').read_text().splitlines():
 if line.startswith('DSH_PHALANX_') and '=' in line:
  key,value=line.split('=',1); parsed=shlex.split(value); values[key]=parsed[0] if len(parsed)==1 else ''
version=json.loads(Path('/etc/dsh-phalanx/installed-manifest.json').read_text())['targetVersion']
match=re.fullmatch(r'(\\d+)\\.(\\d+)\\.(\\d+)(?:-.*)?',version)
assert match, 'Invalid installed platform version'
data=values['DSH_PHALANX_DATA_ROOT']
fallback=os.path.abspath(data)+'.durable/users' if tuple(map(int,match.groups()))>=(0,1,26) else data+'/users'
print(values.get('DSH_PHALANX_USER_DATA_ROOT') or fallback)
`
  const value = (await remote("sudo python3 - <<'PHALANX_STORAGE_LAYOUT'\n" + script + 'PHALANX_STORAGE_LAYOUT')).trim()
  if (!value.startsWith('/') || value.includes('\n')) throw Error('Invalid installed user data root')
  return value
}

export const installedShellArgument = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

/** Resolve the fixture account's existing home from its creation-era storage key. */
export async function installedMemberHome(remote: (command: string) => Promise<string>, storageKey: string): Promise<string> {
  if (!/^(?:member|_spaces\/[a-f0-9]{32})$/u.test(storageKey)) throw Error('Invalid retained fixture storage key')
  return (await installedUserDataRoot(remote)) + '/' + storageKey + '/home'
}

export async function seedInstalledMemberMarker(remote: (command: string) => Promise<string>, storageKey: string) {
  const path = installedShellArgument((await installedMemberHome(remote, storageKey)) + '/upgrade-owned.txt')
  await remote('sudo -u dsh-phalanx sh -c ' + installedShellArgument('printf MEMBER_DATA_PRESERVED > ' + path))
}
