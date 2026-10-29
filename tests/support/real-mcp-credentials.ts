import { readFile, stat } from 'node:fs/promises'
import { execFileText } from '../../src/adapters/runtime-command.js'

export async function readPrivateMcpCredential(path: string): Promise<string> {
  const info = await stat(path)
  if (!info.isFile() || info.mode & 0o077) throw Error('Sample credentials require private regular files')
  const key = (await readFile(path, 'utf8')).trim()
  if (!key || /\s/u.test(key)) throw Error('Credential file must contain one token')
  return key
}

export async function memberExposesMcpCredentials(carrier: string, secrets: readonly string[], requireExperts = false): Promise<boolean> {
  const visible = await execFileText(
    'podman',
    [
      'exec',
      carrier,
      'node',
      '-e',
      `const fs=require('fs'),path=require('path'),chunks=[JSON.stringify(process.env)];
const required=['/dsh-phalanx/member-mcp/entries.json','/dsh-phalanx/home/.dsh/profiles/web/cordis.patch.yml'];
for(const file of required) chunks.push(fs.readFileSync(file,'utf8'));
function scan(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory()&&!['node_modules','.git'].includes(entry.name))scan(file);else if(entry.isFile()&&(/\\.(?:json|ya?ml|[mc]?js|ts|sh|py|md)$/i.test(entry.name)||entry.name==='.env'||entry.name.startsWith('.env.')))chunks.push(fs.readFileSync(file,'utf8'))}}
scan('/dsh-phalanx/home/.dsh');
for(const root of ['/dsh-phalanx/experts','/dsh-phalanx/managed-config']){if(fs.existsSync(root))scan(root);else if(root.endsWith('/experts')&&${JSON.stringify(requireExperts)})throw Error('Required expert mount missing')}
for(const pid of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){for(const name of ['cmdline','environ']){try{chunks.push(fs.readFileSync('/proc/'+pid+'/'+name,'utf8'))}catch(e){if(!['ENOENT','EACCES','EPERM','ESRCH'].includes(e.code))throw e}}}
process.stdout.write(chunks.join('\\n'))`,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  ).catch(async () => {
    throw Error('Member credential inspection failed; output suppressed')
  })
  return secrets.some(secret => visible.includes(secret))
}
