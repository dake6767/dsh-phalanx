/** Method, path and identity requirements for the public HTTP entry. */
export type HttpRouteId = 'model' | 'not-found' | 'bootstrap' | 'admin' | 'login-form' | 'login'
  | 'health' | 'ready' | 'logout' | 'enter' | 'recovery' | 'runtime'
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

export const HTTP_ROUTES: readonly HttpRoute[] = [
  { id: 'model', methods: ['POST'], path: MODEL_GATEWAY_PATH, unsupportedMethod: 'owner', match: 'exact', identity: 'model-token', needsRuntimeRecords: false },
  { id: 'not-found', methods: '*', path: '/_dsh-phalanx/', unsupportedMethod: 'owner', match: 'prefix', identity: 'public', needsRuntimeRecords: false },
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
