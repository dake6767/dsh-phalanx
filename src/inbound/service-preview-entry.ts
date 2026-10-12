import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import type { PreviewIdentity } from '../ports/service-preview.js'
import { ServicePreviewError } from '../ports/service-preview.js'
import type { ServicePreview } from '../use-cases/service-preview.js'
import { previewPath } from './service-preview-gateway.js'
import { acceptsPublicHost } from './public-server.js'
import { sendHtml, sendText } from './http-response.js'
import { htmlText, platformPage } from './platform-page.js'
import { requestLanguage } from './platform-language.js'

/** Trusted outer page owns gesture reporting; application content never runs here. */
export function servicePreviewEntry(deps: {
  dispatch: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  connections: Pick<SessionRegistryPort, 'untrack'>;
  access: ServicePreview; identity: (request: IncomingMessage) => PreviewIdentity | undefined;
  origin: () => URL; previewOrigin: string | undefined; available: () => boolean;
}) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!(request.url ?? '').startsWith('/service-preview/')) { await deps.dispatch(request, response); return }
    deps.connections.untrack(request.socket)
    if (!acceptsPublicHost(request, response, deps.origin())) return
    response.setHeader('content-security-policy', "frame-ancestors 'none'; base-uri 'none'; object-src 'none'")
    response.setHeader('referrer-policy', 'no-referrer')
    const identity = deps.identity(request)
    if (!identity) { sendText(response, 403, 'Preview access expired. Sign in to your own space.'); return }
    if (!deps.available()) { sendText(response, 503, 'Platform maintenance is in progress.'); return }
    const { locale, preference } = requestLanguage(request), zh = locale === 'zh-CN'
    const title = zh ? '服务预览' : 'Service preview'
    if (!deps.previewOrigin) { sendHtml(response, 503, platformPage(title, `<h1>${title}</h1><p>${zh ? '请管理员配置独立的服务预览端口及访问地址。' : 'Ask your administrator to configure the separate preview port and public origin.'}</p>`, '', undefined, locale, preference)); return }
    try {
      const url = new URL(request.url!, deps.origin())
      if (url.pathname === '/service-preview/' && request.method === 'GET') {
        if (url.searchParams.has('port')) {
          const port = Number(url.searchParams.get('port')), path = url.searchParams.get('path') ?? '/'
          if (!path.startsWith('/') || path.startsWith('//') || /[\r\n#]/u.test(path)) throw new ServicePreviewError(403, 'Invalid application path.')
          const target = `/service-preview/${identity.spaceId}/${port}${path}`
          previewPath(target, '/service-preview/'); deps.access.admit(identity, identity.spaceId, port)
          response.writeHead(303, { location: target, 'cache-control': 'no-store' }); response.end(); return
        }
        const port = deps.access.suggestedPort()
        const capability = deps.access.issue(identity, identity.spaceId, port)
        const prefix = `/preview/${identity.spaceId}/${port}/${capability}/`
        const guidance = `${zh ? '在当前用户实例中启动 HTTP 服务，监听' : 'Start an HTTP service in the current user instance on'} 127.0.0.1:${port}. ${zh ? '配置资源、API 和 WebSocket 的基础路径为' : 'Configure the base path for assets, API and WebSocket URLs as'} ${prefix} ${zh ? '此前缀含预览凭据，请勿分享；重新登录或实例替换后需重新获取。端口改变时使用预览页显示的前缀。使用现有执行工具启动服务。' : 'This prefix contains a preview credential; keep it private and obtain a new one after login or instance replacement. For another port, use the prefix displayed on its preview page. Use the existing execution tools to start the service.'}`
        sendHtml(response, 200, platformPage(title, `<h1>${title}</h1><p>${zh ? '打开你在当前空间中启动的临时应用。' : 'Open a temporary application running in your space.'}</p><form method="get"><label>${zh ? '服务端口' : 'Service port'}<input name="port" type="number" min="1024" max="65535" value="${port}" required></label><label>${zh ? '应用路径' : 'Application path'}<input name="path" value="/" required></label><button>${zh ? '打开预览' : 'Open preview'}</button></form><h2>${zh ? '给助手的指引' : 'Instructions for your agent'}</h2><p>${htmlText(guidance)}</p><p>${zh ? '仅本人可访问；退出或回收后需重新登录或启动服务。闲置页面和空闲连接不会持续保活。' : 'Only you can access this preview. After logout or reclamation, sign in or start the service again. Idle pages and connections do not keep the instance alive.'}</p>`, '', undefined, locale, preference)); return
      }
      const targetPath = previewPath(request.url!, '/service-preview/')
      const target = deps.access.admit(identity, targetPath.spaceId, targetPath.port)
      const activity = url.pathname.endsWith('/__activity')
      if (activity) {
        if (request.method !== 'POST' || request.headers.origin !== deps.origin().origin) throw new ServicePreviewError(403, 'Untrusted activity request.')
        deps.access.gesture(target); response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); return
      }
      if (request.method !== 'GET') { sendText(response, 405, 'Method not allowed'); return }
      const capability = deps.access.issue(identity, identity.spaceId, target.port)
      const prefix = `/preview/${identity.spaceId}/${target.port}/${capability}/`
      const frameUrl = deps.previewOrigin + request.url!.replace(`/service-preview/${identity.spaceId}/${target.port}/`, prefix)
      const activityUrl = `/service-preview/${identity.spaceId}/${target.port}/__activity`
      const script = `const frame=document.querySelector('iframe');document.querySelector('#reload').onclick=()=>{frame.src=frame.src};let pending=false;const timer=setInterval(async()=>{if(pending||document.visibilityState!=='visible'||!navigator.userActivation.isActive)return;pending=true;try{const response=await fetch(${JSON.stringify(activityUrl)},{method:'POST',credentials:'same-origin'});if(!response.ok){clearInterval(timer);frame.remove();document.querySelector('#status').textContent=${JSON.stringify(zh ? '预览已失效。重新登录，或在工作区启动服务后重新打开。' : 'Preview expired. Sign in or start the service in your workspace, then reopen.')}}}catch{}finally{pending=false}},250);addEventListener('pagehide',()=>clearInterval(timer));`
      sendHtml(response, 200, platformPage(title, `<style>body{padding:12px}main{max-width:none;margin:0;padding:16px}.brand,.appearance{display:none}iframe{display:block;width:100%;height:calc(100vh - 160px);border:1px solid var(--border);margin-top:12px}header{display:flex;align-items:center;gap:16px}h1{font-size:20px;margin:0}#status{min-height:0;font-size:13px;margin:4px 0;overflow-wrap:anywhere}</style><header><h1>${title}</h1><button id="reload">${zh ? '重新加载' : 'Reload'}</button><a href="/app/${identity.spaceId}/">${zh ? '返回工作区' : 'Back to workspace'}</a></header><p id="status">${htmlText(deps.origin().origin + request.url!)}</p><details><summary>${zh ? '应用配置前缀（请勿分享）' : 'Application prefix (keep private)'}</summary><code>${htmlText(prefix)}</code></details><iframe title="${title}" sandbox="allow-scripts allow-forms" src="${htmlText(frameUrl)}"></iframe>`, script, undefined, locale, preference))
    } catch (error) {
      if (!(error instanceof ServicePreviewError)) throw error
      sendText(response, error.status, error.message)
    }
  }
}
