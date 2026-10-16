import { DSH_BUNDLE_ENABLE, DSH_BUNDLE_LIST } from './plugin-manager-protocol.js'
import { DSH_RPC_PREFIX } from './session-protocol.js'

/** Official invocation patches remain authoritative if a member edits bundle selection. */
export const nativePluginPolicyOverlay = [
  { id: 'plugin-market', disabled: true },
  { id: 'ui-plugin-market', disabled: true },
]

/** Connection authenticates exact routes; Gateway retains native argument validation. */
export const nativePluginPolicy = `
  const customMarketBundle = '@deepseek-ai/dsh-experimental-plugin-market-bundle';
  for (const endpoint of ${JSON.stringify([DSH_BUNDLE_LIST, DSH_BUNDLE_ENABLE])}) {
    ctx.connection.fetch.register({
      path: ${JSON.stringify(DSH_RPC_PREFIX)} + endpoint, methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        let body;
        try { body = await request.json(); } catch { return new Response('Invalid RPC request', {status:400}); }
        if (body?.type !== 'client-request' || typeof body.rpcId !== 'string' || body.method !== endpoint
            || !body.payload?.args || typeof body.payload.args !== 'object' || Array.isArray(body.payload.args)) {
          return new Response('Invalid RPC request', {status:400});
        }
        const reply = result => Response.json({type:'server-response',rpcId:body.rpcId,result});
        const args = body.payload.args;
        if (endpoint === ${JSON.stringify(DSH_BUNDLE_ENABLE)} && args.name === customMarketBundle && args.enabled === true) {
          return reply({ok:false,error:{code:'remote-access/denied',message:'Custom plugin markets are unavailable in this platform.',details:{action:endpoint,reason:'platform-managed'}}});
        }
        const [namespace, method] = endpoint.split('/');
        try {
          const value = await ctx.typertGateway.invoke({namespace,method,args,peer:ctx.connection.browserPeer,signal:request.signal});
          return reply({ok:true,value: endpoint === ${JSON.stringify(DSH_BUNDLE_LIST)} ? value.filter(bundle => bundle.name !== customMarketBundle) : value});
        } catch (error) {
          if (error?.isDSHRemoteError === true) return reply({ok:false,error:{code:error.code,message:error.message,details:error.details}});
          return reply({ok:false,error:{code:'gateway/invocation-unavailable',message:'Plugin management is unavailable.',details:{endpoint}}});
        }
      },
    });
  }
`
