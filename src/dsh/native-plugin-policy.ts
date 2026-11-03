import { DSH_BUNDLE_ENABLE, DSH_BUNDLE_LIST, DSH_BUNDLE_INSTALL } from './plugin-manager-protocol.js'
import { DSH_RPC_PREFIX } from './session-protocol.js'
import { nativeFeatureLocale } from './native-feature-locale.js'
import {
  nativeInstallVerifierModule,
  NATIVE_INSTALL_PROOF_HEADER,
  NATIVE_INSTALL_SIGNATURE_HEADER,
  NATIVE_PLATFORM_INSTALL_PATH,
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
${nativeFeatureLocale}
export const name='phalanx-native-plugin-policy';
export const inject=['connection','typertGateway','settings'];
export function apply(ctx) {
  const configuration=${JSON.stringify(configuration)};
  const verifier=configuration.publicKey ? createVerifier(configuration.publicKey,configuration.subject,configuration.generation) : undefined;
  const customMarketBundle='@deepseek-ai/dsh-experimental-plugin-market-bundle';
  let mutations=Promise.resolve();
  const serialized=operation=>{const result=mutations.then(operation);mutations=result.catch(()=>{});return result;};
  const history=async(mode,signal)=>{
    if (!configuration.history) return [];
    const url=process.env[${JSON.stringify(NATIVE_PLUGIN_HISTORY_ENV)}];
    const token=process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN;
    if (!url || !token) throw new Error('Native plugin history is unavailable');
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-api-key':token},
      body:JSON.stringify({generation:configuration.generation,mode}),signal});
    if (!response.ok) throw new Error('Native plugin history is unavailable');
    const value=await response.json();
    if (!Array.isArray(value.names) || !value.names.every(name=>typeof name==='string')) throw new Error('Native plugin history is unavailable');
    return value.names;
  };
  const invoke=(endpoint,args,signal)=>{
    const [namespace,method]=endpoint.split('/');
    return ctx.typertGateway.invoke({namespace,method,args,peer:ctx.connection.browserPeer,signal});
  };
  for (const endpoint of ${JSON.stringify([DSH_BUNDLE_LIST, DSH_BUNDLE_ENABLE, DSH_BUNDLE_INSTALL])}) {
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
        const perform=async()=>{
          if (path===${JSON.stringify(NATIVE_PLATFORM_INSTALL_PATH)}) {
            const authorization={proof:request.headers.get(${JSON.stringify(NATIVE_INSTALL_PROOF_HEADER)}),signature:request.headers.get(${JSON.stringify(NATIVE_INSTALL_SIGNATURE_HEADER)})};
            const verified=verifier.check(authorization,request.method,path,raw);
            if (!verified.ok) return deny('platform-install-'+verified.reason,'Platform installation authorization is unavailable.');
          } else if (privateInstall && !configuration.allowInstall) return groupDenied();
          if (endpoint===${JSON.stringify(DSH_BUNDLE_ENABLE)} && args.name===customMarketBundle && args.enabled===true)
            return deny('platform-managed','Custom plugin markets are unavailable in this platform.');
          if (endpoint===${JSON.stringify(DSH_BUNDLE_ENABLE)} && args.enabled===true && !configuration.allowInstall) {
            const bundles=await invoke(${JSON.stringify(DSH_BUNDLE_LIST)},{},request.signal);
            const bundle=bundles.find(row=>row.name===args.name);
            if (bundle?.official===true && bundle.optional===true && !bundle.enabled && !bundle.installed
              && !(await history('read',request.signal)).includes(bundle.name)) return groupDenied();
          }
          const value=await invoke(endpoint,args,request.signal);
          if ((privateInstall || (endpoint===${JSON.stringify(DSH_BUNDLE_ENABLE)} && args.enabled===true))
            && ['applied','restart-required'].includes(value?.application)) await history('refresh',request.signal);
          return reply({ok:true,value:endpoint===${JSON.stringify(DSH_BUNDLE_LIST)} ? value.filter(bundle=>bundle.name!==customMarketBundle) : value});
        };
        try { return await (endpoint===${JSON.stringify(DSH_BUNDLE_LIST)} ? perform() : serialized(perform)); }
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
