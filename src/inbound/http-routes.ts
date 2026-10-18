/** Method, path and identity requirements for the public HTTP entry. */
export type HttpRouteId = 'contributions' | 'mcp' | 'execution' | 'model' | 'web-tools' | 'plugin-upstream' | 'not-found' | 'bootstrap' | 'admin' | 'login-form' | 'login'
  | 'market' | 'health' | 'ready' | 'logout' | 'enter' | 'recovery' | 'identity' | 'runtime'
export type RouteIdentity = 'public' | 'model-token' | 'administrator' | 'platform-user'

interface HttpRoute {
  readonly id: HttpRouteId
  readonly methods: readonly string[] | '*'
  readonly unsupportedMethod: 'owner' | 'runtime'
  readonly path: string
  readonly match: 'exact' | 'prefix'
  readonly identity: RouteIdentity
  readonly needsRuntimeRecords: boolean
}

import { MODEL_GATEWAY_PATH } from '../dsh/model-protocol.js'
import { WEB_TOOLS_GATEWAY_PATHS } from '../dsh/web-tools.js'

export const HTTP_ROUTES: readonly HttpRoute[] = [
  { id: 'contributions', methods: '*', path: '/contributions', unsupportedMethod: 'owner', match: 'exact', identity: 'model-token', needsRuntimeRecords: true },
  { id: 'mcp', methods: '*', path: '/mcp-test/', unsupportedMethod: 'owner', match: 'prefix', identity: 'model-token', needsRuntimeRecords: false },
  { id: 'mcp', methods: '*', path: '/mcp/', unsupportedMethod: 'owner', match: 'prefix', identity: 'model-token', needsRuntimeRecords: false },
  { id: 'execution', methods: '*', path: '/execution', unsupportedMethod: 'owner', match: 'exact', identity: 'model-token', needsRuntimeRecords: false },
  { id: 'plugin-upstream', methods: '*', path: '/plugins/', unsupportedMethod: 'owner', match: 'prefix', identity: 'model-token', needsRuntimeRecords: false },
  { id: 'market', methods: '*', path: '/market/api/', unsupportedMethod: 'owner', match: 'prefix', identity: 'platform-user', needsRuntimeRecords: true },
  ...['/market', '/market/'].map(path => ({ id: 'not-found' as const, methods: '*' as const, path, unsupportedMethod: 'owner' as const, match: path.endsWith('/') ? 'prefix' as const : 'exact' as const, identity: 'public' as const, needsRuntimeRecords: false })),
  { id: 'model', methods: ['POST'], path: MODEL_GATEWAY_PATH, unsupportedMethod: 'owner', match: 'exact', identity: 'model-token', needsRuntimeRecords: false },
  ...Object.values(WEB_TOOLS_GATEWAY_PATHS).map(path => ({ id: 'web-tools' as const, methods: ['POST'] as const, path, unsupportedMethod: 'owner' as const, match: 'exact' as const, identity: 'model-token' as const, needsRuntimeRecords: false })),
  { id: 'not-found', methods: '*', path: '/_dsh-phalanx/', unsupportedMethod: 'owner', match: 'prefix', identity: 'public', needsRuntimeRecords: false },
  { id: 'identity', methods: '*', path: '/account/identity', unsupportedMethod: 'owner', match: 'exact', identity: 'platform-user', needsRuntimeRecords: true },
  { id: 'not-found', methods: '*', path: '/account/', unsupportedMethod: 'owner', match: 'prefix', identity: 'public', needsRuntimeRecords: false },
  { id: 'bootstrap', methods: ['GET', 'POST'], path: '/bootstrap', unsupportedMethod: 'owner', match: 'exact', identity: 'public', needsRuntimeRecords: true },
  { id: 'admin', methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'], path: '/admin', unsupportedMethod: 'owner', match: 'exact', identity: 'administrator', needsRuntimeRecords: true },
  { id: 'admin', methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'], path: '/admin/', unsupportedMethod: 'owner', match: 'prefix', identity: 'administrator', needsRuntimeRecords: true },
  { id: 'login-form', methods: ['GET'], path: '/login', unsupportedMethod: 'runtime', match: 'exact', identity: 'public', needsRuntimeRecords: true },
  { id: 'login', methods: ['POST'], path: '/login', unsupportedMethod: 'runtime', match: 'exact', identity: 'public', needsRuntimeRecords: true },
  { id: 'ready', methods: ['GET'], path: '/readyz', unsupportedMethod: 'runtime', match: 'exact', identity: 'public', needsRuntimeRecords: false },
  { id: 'health', methods: ['GET'], path: '/healthz', unsupportedMethod: 'runtime', match: 'exact', identity: 'public', needsRuntimeRecords: false },
  { id: 'logout', methods: ['POST'], path: '/logout', unsupportedMethod: 'runtime', match: 'exact', identity: 'platform-user', needsRuntimeRecords: true },
  { id: 'enter', methods: ['GET'], path: '/enter', unsupportedMethod: 'runtime', match: 'exact', identity: 'platform-user', needsRuntimeRecords: true },
  { id: 'recovery', methods: '*', path: '/recovery', unsupportedMethod: 'owner', match: 'exact', identity: 'platform-user', needsRuntimeRecords: true },
  { id: 'recovery', methods: '*', path: '/recovery/', unsupportedMethod: 'owner', match: 'prefix', identity: 'platform-user', needsRuntimeRecords: true },
  { id: 'runtime', methods: '*', unsupportedMethod: 'owner', path: '/', match: 'prefix', identity: 'platform-user', needsRuntimeRecords: true },
]

export function matchHttpRoute(method: string | undefined, pathname: string): HttpRoute {
  const route = HTTP_ROUTES.find(candidate =>
    (candidate.match === 'exact' ? candidate.path === pathname : pathname.startsWith(candidate.path))
    && (candidate.methods === '*' || candidate.methods.includes(method ?? 'GET') || candidate.unsupportedMethod === 'owner'))
  if (route === undefined) throw new Error('HTTP route table has no runtime fallback')
  return route
}
