import { readFile, stat } from 'node:fs/promises'
import { execFileText } from '../../src/adapters/runtime-command.js'

export async function readPrivateMcpCredential(path: string): Promise<string> {
  const info = await stat(path)
  if (!info.isFile() || (info.mode & 0o077)) throw Error('Sample credentials require private regular files')
  const key = (await readFile(path, 'utf8')).trim()
  if (!key || /\s/u.test(key)) throw Error('Credential file must contain one token')
  return key
}

export async function memberExposesMcpCredentials(carrier: string, secrets: readonly string[]): Promise<boolean> {
  const visible = await execFileText('podman', ['exec', carrier, 'node', '-e', `const fs=require('fs'),path=require('path'),chunks=[JSON.stringify(process.env)];
const required=['/dsh-phalanx/member-mcp/entries.json','/dsh-phalanx/home/.dsh/profiles/web/cordis.patch.yml'];
for(const file of required) chunks.push(fs.readFileSync(file,'utf8'));
function scan(dir,depth=0){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory()&&depth<3&&!['node_modules','.git'].includes(entry.name))scan(file,depth+1);else if(entry.isFile()&&(/\\.(?:json|ya?ml)$/i.test(entry.name)||entry.name==='.env'||entry.name.startsWith('.env.')))chunks.push(fs.readFileSync(file,'utf8'))}}
scan('/dsh-phalanx/home/.dsh');
for(const pid of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){for(const name of ['cmdline','environ']){try{chunks.push(fs.readFileSync('/proc/'+pid+'/'+name,'utf8'))}catch(e){if(!['ENOENT','EACCES','EPERM','ESRCH'].includes(e.code))throw e}}}
process.stdout.write(chunks.join('\\n'))`]).catch(() => { throw Error('Member credential inspection failed; output suppressed') })
  return secrets.some(secret => visible.includes(secret))
}
