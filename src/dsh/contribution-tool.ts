import { DSH_PROFILES_DIRECTORY, DSH_WEB_PROFILE, DSH_PROFILE_MANIFEST } from './profile-layout.js'
import { inspectContributionCredentials, excludedContributionFile, scanContributionCredentials, contributionDeclarationTexts, redactContributionDeclaration, redactContributionContent } from '../domain/contribution-checks.js'
/** Official global tools, embedded skills and foreground userQuestions seams. */
export const contributionGuide = `# Contributing a skill or plugin\nRead the skill or plugin, describe its purpose, then call submit_contribution with action submit, its directory path, and purpose. The member must click Submit before any upload. Never supply confirmation on their behalf. Sub-agents must return to the main conversation. The tool excludes .env files, private keys and certificates. Remove credentials from all remaining files. Skills must contain one SKILL.md, use a unique name, and fit within 20 MB. Pending submissions with the same name replace your earlier submission. Use action status to query and action withdraw with an id to withdraw. Declarations use {purpose, execution?: {commands: [{command, blocked: []}], variables: [{name, purpose, application}], prepare?: string}}. Never include variable values. Findings return code, severity, path and advice without matched values. Rejected findings require modification. For warnings, ask the member whether to modify; only if they explicitly keep them call again with retainWarnings true. The next confirmation card lists retained warnings. Administrator configuration starts with the declared names; only the administrator enters secrets and prepares dependencies. For plugins use kind plugin and either source local with a directory containing package.json and dsh.bundle.patch, or source npm with packageName and exact version. Local plugin archives fit within 50 MB and are prechecked privately by the platform before review. Adoption creates an independent platform copy, without changing your local copy.`
export const contributionToolModule = `
import { readdir, readFile, realpath, lstat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { crc32, gzipSync } from 'node:zlib';
import { parse } from './yaml/dist/index.js';
const guide=${JSON.stringify(contributionGuide)};
const scanContributionCredentials=${scanContributionCredentials.toString()};
const contributionDeclarationTexts=${contributionDeclarationTexts.toString()};
const redactContributionContent=${redactContributionContent.toString()};
const redactContributionDeclaration=${redactContributionDeclaration.toString()};
const inspectCredentials=${inspectContributionCredentials.toString()};
const excludedFile=${excludedContributionFile.toString()};
export const name='phalanx-contribution-tools';
export const inject=['tools','userQuestions','agents','skills'];
function zip(files){
 const entries=[],index=[];let offset=0;
 for(const file of files){
  const name=Buffer.from(file.path),header=Buffer.alloc(30),central=Buffer.alloc(46);
  header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);
  header.writeUInt32LE(crc32(file.bytes),14);header.writeUInt32LE(file.bytes.length,18);header.writeUInt32LE(file.bytes.length,22);header.writeUInt16LE(name.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(0x0314,4);header.copy(central,6,4,30);central.writeUInt32LE((0o100555*65536)>>>0,38);central.writeUInt32LE(offset,42);
  entries.push(header,name,file.bytes);index.push(central,name);offset+=header.length+name.length+file.bytes.length;
 }
 const directory=Buffer.concat(index),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...entries,directory,end]);
}
function tgz(files){
 const chunks=[];
 for(const file of files){
  const name='package/'+file.path,header=Buffer.alloc(512);let basename=name,prefix='';
  if(Buffer.byteLength(name)>100){const split=name.lastIndexOf('/');basename=name.slice(split+1);prefix=name.slice(0,split);}
  if(Buffer.byteLength(basename)>100||Buffer.byteLength(prefix)>155)throw new Error('plugin-package-invalid: Shorten package file paths.');
  header.write(basename,0,100);header.write('0000755'+String.fromCharCode(0),100,8);header.write('0000000'+String.fromCharCode(0),108,8);header.write('0000000'+String.fromCharCode(0),116,8);
  header.write(file.bytes.length.toString(8).padStart(11,'0')+String.fromCharCode(0),124,12);header.write('00000000000'+String.fromCharCode(0),136,12);header.fill(32,148,156);header.write('0',156);header.write('ustar'+String.fromCharCode(0),257,6);header.write('00',263,2);header.write(prefix,345,155);
  const checksum=header.reduce((sum,value)=>sum+value,0);header.write(checksum.toString(8).padStart(6,'0')+String.fromCharCode(0)+' ',148,8);
  chunks.push(header,file.bytes,Buffer.alloc((512-file.bytes.length%512)%512));
 }
 return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));
}
async function pack(path,signal,kind='skill'){
 const root=await realpath(path),files=[],excluded=[];let size=0;
 async function walk(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
   signal.throwIfAborted();const full=join(directory,entry.name),path=relative(root,full);
   if(excludedFile(path)||['.git','node_modules'].includes(entry.name)){excluded.push(path);continue}
   if(entry.isSymbolicLink()||!entry.isDirectory()&&!entry.isFile())throw new Error('contribution-unsafe-file: Remove links and special files.');
   if(entry.isDirectory()){await walk(full);continue}
   const stat=await lstat(full);if(stat.isSymbolicLink()||!stat.isFile())throw new Error('contribution-unsafe-file');
   const canonical=await realpath(full),rel=relative(root,canonical);if(rel.startsWith('..')||isAbsolute(rel))throw new Error('contribution-unsafe-file');
   size+=stat.size;if(size>(kind==='plugin'?50:20)*1024*1024||files.length>=10000)throw new Error('skill-upload-too-large: Limit the skill to 20 MB and 10000 files.');
   const bytes=await readFile(full);if(bytes.length!==stat.size)throw new Error('contribution-changed: Review changed files again.');
   files.push({path,bytes});
  }
 }
 await walk(root);if(kind==='skill'&&!files.some(file=>file.path==='SKILL.md'))throw new Error('skill-frontmatter-invalid: Select a directory containing SKILL.md.');
 const bytes=kind==='plugin'?tgz(files):zip(files);if(bytes.length>(kind==='plugin'?50:20)*1024*1024)throw new Error('skill-upload-too-large');
 if(kind==='plugin'){let manifest;try{manifest=JSON.parse(files.find(file=>file.path==='package.json')?.bytes.toString('utf8')||'')}catch{};if(!manifest?.name||!manifest?.version||!manifest?.dsh?.bundle?.patch)throw new Error('plugin-package-invalid: Add package.json with name, exact version and dsh.bundle.patch.');let registry=false;try{const profile=join(process.env.DSH_HOME,${JSON.stringify(DSH_PROFILES_DIRECTORY)},${JSON.stringify(DSH_WEB_PROFILE)}),installed=await realpath(join(profile,'node_modules',manifest.name)),spec=JSON.parse(await readFile(join(profile,${JSON.stringify(DSH_PROFILE_MANIFEST)}),'utf8')).dependencies?.[manifest.name];registry=installed===root&&typeof spec==='string'&&!spec.includes(':')&&!spec.includes('/')&&![...spec].some(char=>char.charCodeAt(0)===92);}catch{};return {bytes,name:manifest.name,version:manifest.version,registry,contents:files.map(file=>({path:file.path,content:file.bytes.toString('utf8')})),files:files.map(file=>file.path),excluded};}
 const markdown=files.find(file=>file.path==='SKILL.md').bytes.toString('utf8'),frontmatter=/^---\\r?\\n([\\s\\S]*?)\\r?\\n---(?:\\r?\\n|$)/.exec(markdown);
 let name;try{name=parse(frontmatter?.[1]||'',{logLevel:'silent'})?.name}catch{}
 if(typeof name!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))throw new Error('skill-frontmatter-invalid: Add a valid skill name to SKILL.md.');
 return {bytes,name,contents:files.map(file=>({path:file.path,content:file.bytes.toString('utf8')})),files:files.map(file=>file.path),excluded};
}
export function apply(ctx){
 ctx.skills.register({name:'platform-contribution-guide',description:'Submit a skill or plugin to the platform after the member confirms.',source:'runtime',content:guide});
 ctx.tools.register({name:'submit_contribution',description:'Contribute a skill or plugin to the platform for administrator review. Read this guide first: '+guide,
 parameters:{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['skill','plugin']},source:{type:'string',enum:['local','npm']},packageName:{type:'string'},version:{type:'string'},action:{type:'string',enum:['submit','status','withdraw']},path:{type:'string'},purpose:{type:'string'},declaration:{type:'object',description:'Value-free declaration: purpose, optional execution {commands:[{command,blocked:[]}],variables:[{name,purpose,application}],prepare}. Never include credential values.'},retainWarnings:{type:'boolean',description:'Only true after the member explicitly chooses to retain the reported warnings.'},id:{type:'string'}},required:['action']},
 output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
 async execute(args,exec){
  if(!exec.agent||!ctx.agents.roots().includes(exec.agent))return {code:'contribution-main-session-required',advice:'Return to the main conversation to submit. 需在主会话提交。'};
  const endpoint=new URL('/contributions',process.env.DSH_PHALANX_MODEL_GATEWAY_URL);
  const headers={'x-api-key':process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN};let init={headers,signal:exec.signal};
  if(args.action==='withdraw'){endpoint.searchParams.set('action','withdraw');init={...init,method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({id:args.id})}}
  else if(args.action==='submit'){
   const declaration=args.declaration||{purpose:args.purpose},kind=args.kind||'skill';let npm=kind==='plugin'&&args.source==='npm';
   if(!npm&&typeof args.path!=='string'||typeof declaration.purpose!=='string'||!declaration.purpose.trim())return {code:'contribution-invalid',advice:'Provide a skill directory and purpose.'};
   if(declaration.execution?.variables?.some(row=>Object.keys(row).some(key=>!['name','purpose','application'].includes(key))))return {status:'rejected',code:'contribution-invalid',advice:'Declare secret variable names, purpose and application instructions only; remove all values.'};
   if(npm&&(typeof args.packageName!=='string'||typeof args.version!=='string'))return {code:'plugin-identity-invalid',advice:'Provide an exact npm package name and version.'};
   const packed=npm?{name:args.packageName,version:args.version,contents:[],files:[],excluded:[]}:await pack(resolve(exec.agent.session.header.cwd||process.cwd(),args.path),exec.signal,kind);
   if(kind==='plugin'&&packed.registry)npm=true;
   const findings=inspectCredentials([...packed.contents,...contributionDeclarationTexts(declaration)]);
   if(findings.some(row=>row.severity==='reject')||findings.length&&!args.retainWarnings)return {status:findings.some(row=>row.severity==='reject')?'rejected':'needs-review',findings};
   const detail=(kind==='plugin'?'Plugin / 插件: ':'Skill / 技能: ')+packed.name+(packed.version?'@'+packed.version:'')+'\\nSource / 来源: '+(kind==='skill'?'Skill ZIP':npm?'npm registry (exact version)':'Local directory TGZ')+'\\n\\n'+JSON.stringify(redactContributionDeclaration(declaration),null,2)+'\\n\\nFiles ('+packed.files.length+'):\\n'+packed.files.join('\\n')+'\\n\\nExcluded:\\n'+(packed.excluded.join('\\n')||'None')+'\\n\\nWarnings retained: '+(args.retainWarnings?'Yes':'No')+'\\n'+findings.map(row=>row.code+': '+row.advice).join('\\n');
   const answer=await ctx.userQuestions.ask({agent:exec.agent,signal:exec.signal,questions:[{id:'submit-contribution',header:'Submit contribution / 提交贡献',question:'Submit this contribution to the platform? / 将此贡献提交到平台？',detail,options:[{label:'Submit / 提交'},{label:'Cancel / 取消'}]}]});
   if(answer.answers.length!==1||answer.answers[0].selected.length!==1||answer.answers[0].selected[0]!=='Submit / 提交')return {status:'cancelled'};
   exec.signal.throwIfAborted();endpoint.searchParams.set('action','submit');if(args.retainWarnings)endpoint.searchParams.set('retainWarnings','true');if(kind==='plugin')endpoint.searchParams.set('kind','plugin');if(npm)init={...init,method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({packageName:packed.name,version:packed.version,declaration})};else{const metadata=Buffer.from(JSON.stringify(declaration)),prefix=Buffer.alloc(4);prefix.writeUInt32BE(metadata.length);init={...init,method:'POST',headers:{...headers,'content-type':kind==='plugin'?'application/vnd.dsh-phalanx.contribution+tgz':'application/vnd.dsh-phalanx.contribution+zip'},body:Buffer.concat([prefix,metadata,packed.bytes])};}
  }
  const response=await fetch(endpoint,init);return await response.json();
 }});
}
`
