import { nativeFeatureLocale } from './native-feature-locale.js'
import { DSH_RPC_PREFIX } from './session-protocol.js'

/** The disabled controller has no native descriptor; explain the group choice at its public HTTP seam. */
export const nativeTerminalAccessModule = `
export const name = 'phalanx-native-terminal-access';
export const inject = ['connection', 'settings'];
${nativeFeatureLocale}
export function apply(ctx) {
  ctx.connection.fetch.register({
    path: ${JSON.stringify(DSH_RPC_PREFIX)} + 'terminal/create', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      let body;
      try { body = await request.json(); } catch { return new Response('Invalid RPC request', {status:400}); }
      if (body?.type !== 'client-request' || typeof body.rpcId !== 'string' || body.method !== 'terminal/create'
        || !body.payload?.args || typeof body.payload.args !== 'object' || Array.isArray(body.payload.args))
        return new Response('Invalid RPC request', {status:400});
      const zh = nativeFeatureChinese(ctx,request);
      const message = zh ? '此分组未开放手动终端。Agent 执行命令和平台代执行仍可使用。'
        : 'Manual terminal access is unavailable for this group. Agent commands and platform execution remain available.';
      return Response.json({type:'server-response',rpcId:body.rpcId,result:{ok:false,error:{code:'remote-access/denied',message,details:{action:'terminal/create',reason:'group-native-feature'}}}});
    },
  });
}
`
