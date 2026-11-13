import { DSH_BUNDLE_ENABLE, DSH_BUNDLE_LIST, DSH_BUNDLE_INSTALL, DSH_BUNDLE_REMOVE, DSH_BUNDLE_UPDATE, DSH_PLUGIN_ENABLE } from './plugin-manager-protocol.js'
import { DSH_RPC_PREFIX } from './session-protocol.js'
import { nativeReplacementImports, nativeReplacementModule } from './native-plugin-replacement.js'
import { DSH_SETTINGS_UPDATE, DSH_SETTINGS_REPLACE, DSH_SETTINGS_MUTATE } from './settings-protocol.js'
import { nativePackageCacheModule } from './native-package-cache.js'
import { nativeServiceSettingsModule } from './native-service-settings.js'
import { nativeFeatureLocale } from './native-feature-locale.js'
import {
  nativeInstallVerifierModule,
  NATIVE_INSTALL_PROOF_HEADER,
  NATIVE_INSTALL_SIGNATURE_HEADER,
  NATIVE_PLATFORM_INSTALL_PATH,
  NATIVE_PLATFORM_SETTINGS_PATH,
  NATIVE_PLATFORM_SETTINGS_METHOD,
  NATIVE_PLUGIN_HISTORY_ENV,
} from './native-plugin-install.js'

/** Official invocation patches remain authoritative if a member edits bundle selection. */
export const nativePluginPolicyOverlay = [
  { id: 'plugin-market', disabled: true },
  { id: 'ui-plugin-market', disabled: true },
]

export interface NativePluginPolicyConfiguration {
  readonly subject: string
  readonly generation: string
  readonly allowInstall: boolean
  readonly publicKey?: string
  readonly history?: boolean
}

/** One member policy owns all intercepted bundle routes, including custom-market exclusions. */
export function nativePluginPolicyModule(configuration: NativePluginPolicyConfiguration): string {
  return `${nativeInstallVerifierModule}
${nativeReplacementImports}
${nativeReplacementModule}
${nativeFeatureLocale}
${nativeServiceSettingsModule}
${nativePackageCacheModule(configuration.generation)}
async function retainedArchiveIntegrity(spec) {
  if (typeof spec!=='string') return;
  const marker=spec.indexOf('file:');
  let path=marker===-1 ? spec : spec.slice(marker+5);
  if (marker===-1 && !path.includes('/')) return;
  try { path=path.startsWith('//') && marker!==-1 ? fileURLToPath('file:'+path) : decodeURIComponent(path); }
  catch { return; }
  if (path.startsWith('~/') && process.env.HOME) path=resolve(process.env.HOME,path.slice(2));
  const digest=value=>value.startsWith(archiveDirectory+'/') && /^([a-f0-9]{128})[.]tgz$/.exec(value.slice(archiveDirectory.length+1))?.[1];
  for (const candidate of new Set([resolve(profileDirectory,path),resolve(path)])) {
    const hash=digest(candidate) || digest(await realpath(candidate).catch(()=>''));
    if (hash) return 'sha512-'+Buffer.from(hash,'hex').toString('base64');
  }
}
export const name='phalanx-native-plugin-policy';
export const inject=['connection','typertGateway','settings'];
export function apply(ctx) {
  const configuration=${JSON.stringify(configuration)};
  const verifier=configuration.publicKey ? createVerifier(configuration.publicKey,configuration.subject,configuration.generation) : undefined;
  const customMarketBundle='@deepseek-ai/dsh-experimental-plugin-market-bundle';
  let mutations=Promise.resolve();
  let pendingMutations=0;
  const replacements=new Map(), installations=new Map();
  const serialized=operation=>{
    pendingMutations++;
    const result=mutations.then(operation).finally(()=>{pendingMutations--});
    mutations=result.catch(()=>{});
    return result;
  };
  const historyRequest=async(input,signal)=>{
    const url=process.env[${JSON.stringify(NATIVE_PLUGIN_HISTORY_ENV)}];
    const token=process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN;
    if (!url || !token) throw new Error('Native plugin history is unavailable');
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-api-key':token},
      body:JSON.stringify({generation:configuration.generation,...input}),signal});
    if (!response.ok) throw new Error('Native plugin history is unavailable');
    return await response.json();
  };
  const history=async(mode,signal)=>{
    if (!configuration.history) return [];
    const value=await historyRequest({mode},signal);
    if (!Array.isArray(value.names) || !value.names.every(name=>typeof name==='string')) throw new Error('Native plugin history is unavailable');
    return value.names;
  };
  const invoke=(endpoint,args,signal)=>{
    const [namespace,method]=endpoint.split('/');
    return ctx.typertGateway.invoke({namespace,method,args,peer:ctx.connection.browserPeer,signal});
  };
  const settingsProvider=async input=>{
    const service=input?.binding?.service;
    if (!settingsKey(service) || typeof input.packageName!=='string'
      || !/^(?:@[a-z0-9._-]+[/])?[a-z0-9][a-z0-9._-]*$/.test(input.packageName)) return;
    const archive=archivePath(input.integrity);
    if (!archive || !await resolvedArchive(input.packageName,archive,input.integrity)) return;
    const providers=Object.getOwnPropertySymbols(ctx.reflect.store)
      .map(key=>ctx.reflect.store[key]).filter(row=>row?.name===service);
    if (providers.length!==1) return;
    const provider=providers[0].ctx.fiber;
    let fiber=provider;
    const seen=new Set();
    while (fiber && !fiber.entry && !seen.has(fiber)) { seen.add(fiber); fiber=fiber.parent?.fiber; }
    const entry=fiber?.entry;
    const base=entry?.parent.tree.ctx.baseUrl;
    const pkg=base && ctx.get('pluginPackages')?.packageOf(entry.options.name,base);
    if (provider.state!==2 || fiber?.state!==2 || pkg?.name!==input.packageName || pkg.version!==input.version) return;
    const native=await realpath(join(profileDirectory,'node_modules',input.packageName));
    if (native!==await realpath(pkg.dir)) return;
    return providers[0];
  };
  if (verifier) ctx.connection.fetch.register({
    path:${JSON.stringify(NATIVE_PLATFORM_SETTINGS_PATH)},methods:['POST'],requestBody:'buffered',
    fetch:async request=>{
      const raw=await request.text();
      const authorization={proof:request.headers.get(${JSON.stringify(NATIVE_INSTALL_PROOF_HEADER)}),signature:request.headers.get(${JSON.stringify(NATIVE_INSTALL_SIGNATURE_HEADER)})};
      if (!verifier.check(authorization,request.method,${JSON.stringify(NATIVE_PLATFORM_SETTINGS_PATH)},raw).ok)
        return new Response('Platform operation authorization is unavailable',{status:403});
      let body;
      try { body=JSON.parse(raw); }
      catch { return new Response('Invalid RPC request',{status:400}); }
      if (body?.type!=='client-request' || typeof body.rpcId!=='string'
        || body.method!==${JSON.stringify(NATIVE_PLATFORM_SETTINGS_METHOD)} || !settingsObject(body.payload?.args))
        return new Response('Invalid RPC request',{status:400});
      const input=body.payload.args;
      if (input.phase!=='preview' && input.phase!=='apply') return new Response('Invalid RPC request',{status:400});
      const reply=value=>Response.json({type:'server-response',rpcId:body.rpcId,result:{ok:true,value}});
      try {
        return await serialized(async()=>{
          const provider=await settingsProvider(input);
          if (!provider) return reply({status:'unsupported'});
          const service=input.binding.service;
          const result=await syncNativeServiceSettings((endpoint,args)=>{
            const strict=ctx.get('typert')?.local.get(endpoint);
            const providers=Object.getOwnPropertySymbols(ctx.reflect.store).map(key=>ctx.reflect.store[key]).filter(row=>row?.name===service);
            if (provider.ctx.fiber.state!==2 || providers.length!==1 || providers[0]!==provider
              || strict && (strict.service!==service || strict.invocation.kind!=='direct'))
              throw new Error('Native settings provider changed');
            return invoke(endpoint,args,request.signal);
          },input);
          return reply(result);
        });
      } catch { return reply({status:'failed'}); }
    },
  });
  for (const endpoint of ${JSON.stringify([
    DSH_BUNDLE_LIST,
    DSH_BUNDLE_ENABLE,
    DSH_BUNDLE_INSTALL,
    DSH_BUNDLE_REMOVE,
    DSH_BUNDLE_UPDATE,
    DSH_PLUGIN_ENABLE,
    DSH_SETTINGS_UPDATE,
    DSH_SETTINGS_REPLACE,
    DSH_SETTINGS_MUTATE,
  ])}) {
    const privateInstall=endpoint===${JSON.stringify(DSH_BUNDLE_INSTALL)};
    const paths=[${JSON.stringify(DSH_RPC_PREFIX)}+endpoint,...(privateInstall && verifier ? [${JSON.stringify(NATIVE_PLATFORM_INSTALL_PATH)}] : [])];
    for (const path of paths) ctx.connection.fetch.register({
      path,methods:['POST'],requestBody:'buffered',
      fetch:async request=>{
        const raw=await request.text();
        let body;
        try {body=JSON.parse(raw);} catch {return new Response('Invalid RPC request',{status:400});}
        if (body?.type!=='client-request' || typeof body.rpcId!=='string' || body.method!==endpoint
          || !body.payload?.args || typeof body.payload.args!=='object' || Array.isArray(body.payload.args))
          return new Response('Invalid RPC request',{status:400});
        const reply=result=>Response.json({type:'server-response',rpcId:body.rpcId,result});
        const deny=(reason,message)=>reply({ok:false,error:{code:'remote-access/denied',message,details:{action:endpoint,reason}}});
        const groupDenied=()=>deny('group-native-feature',nativeFeatureChinese(ctx,request)
          ? '平台已禁用自行添加插件，请联系管理员' : 'The platform has disabled adding plugins. Contact your administrator.');
        const args=body.payload.args;
        const signed=path===${JSON.stringify(NATIVE_PLATFORM_INSTALL_PATH)};
        if (signed) {
          const authorization={proof:request.headers.get(${JSON.stringify(NATIVE_INSTALL_PROOF_HEADER)}),signature:request.headers.get(${JSON.stringify(NATIVE_INSTALL_SIGNATURE_HEADER)})};
          const verified=verifier.check(authorization,request.method,path,raw);
          if (!verified.ok) return deny('platform-install-'+verified.reason,'Platform installation authorization is unavailable.');
        } else if (privateInstall && !configuration.allowInstall) return groupDenied();
        const perform=async()=>{
          if (privateInstall && !signed && verifier && configuration.history) {
            const integrity=await retainedArchiveIntegrity(args.spec);
            if (integrity) {
              const value=await historyRequest({mode:'archive',integrity},request.signal);
              if (typeof value.reserved!=='boolean') throw new Error('Native plugin archive policy is unavailable');
              if (value.reserved) return deny('platform-archive','Install this platform archive through the App Center.');
            }
          }
          if (endpoint===${JSON.stringify(DSH_BUNDLE_ENABLE)} && args.name===customMarketBundle && args.enabled===true)
            return deny('platform-managed','Custom plugin markets are unavailable in this platform.');
          if (endpoint===${JSON.stringify(DSH_BUNDLE_ENABLE)} && args.enabled===true && !configuration.allowInstall) {
            const bundles=await invoke(${JSON.stringify(DSH_BUNDLE_LIST)},{},request.signal);
            const bundle=bundles.find(row=>row.name===args.name);
            if (bundle?.official===true && bundle.optional===true && !bundle.enabled && !bundle.installed
              && !(await history('read',request.signal)).includes(bundle.name)) return groupDenied();
          }
          const value=privateInstall && signed
            ? await installWithNativeCache(nativeArgs=>invoke(endpoint,nativeArgs,request.signal),args,request.signal)
            : await invoke(endpoint,args,request.signal);
          if ((privateInstall || (endpoint===${JSON.stringify(DSH_BUNDLE_ENABLE)} && args.enabled===true))
            && ['applied','restart-required'].includes(value?.application)) {
            const refresh=history('refresh',request.signal);
            if (signed) await refresh.catch(()=>{});
            else await refresh;
          }
          return reply({ok:true,value:endpoint===${JSON.stringify(DSH_BUNDLE_LIST)} ? value.filter(bundle=>bundle.name!==customMarketBundle) : value});
        };
        try {
          if (signed && args.replacement !== undefined) {
            const id=args.options?.requestId;
            if (typeof id!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return deny('invalid-update','Invalid update request.');
            const existing=replacements.get(id);
            if (existing) return existing.raw===raw ? reply({ok:true,value:await existing.result}) : deny('invalid-update','Update request changed.');
            for (const [key,operation] of replacements) if (operation.until<=Date.now()) replacements.delete(key);
            if (pendingMutations || replacements.size>=128)
              return reply({ok:true,value:{replacement:'changed',reason:'native-busy'}});
            const operation={raw,until:Infinity,result:serialized(()=>
              installWithNativeCache(nativeArgs=>replaceNativeBundle(invoke,nativeArgs),args,AbortSignal.timeout(660000)))};
            replacements.set(id,operation);
            const done=()=>{operation.until=Date.now()+15*60*1000};
            void operation.result.then(done,done);
            return reply({ok:true,value:await operation.result});
          }
          if (signed && typeof args.options?.requestId==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(args.options.requestId)) {
            const id=args.options.requestId;
            for (const [key,operation] of installations) if (operation.until<=Date.now()) installations.delete(key);
            const existing=installations.get(id);
            if (existing) return existing.raw===raw ? (await existing.result).clone() : deny('invalid-install','Install request changed.');
            if (installations.size>=128) return deny('native-busy','Native installation is busy.');
            const operation={raw,until:Infinity,result:serialized(perform)};
            installations.set(id,operation);
            const done=()=>{operation.until=Date.now()+15*60*1000};
            void operation.result.then(done,done);
            return (await operation.result).clone();
          }
          return await (endpoint===${JSON.stringify(DSH_BUNDLE_LIST)} ? perform() : serialized(perform));
        }
        catch(error) {
          if (error?.isDSHRemoteError===true) return reply({ok:false,error:{code:error.code,message:error.message,details:error.details}});
          return reply({ok:false,error:{code:'gateway/invocation-unavailable',message:'Plugin management or history recording is unavailable. Check the native state before retrying.',details:{endpoint}}});
        }
      },
    });
  }
}
`
}
