import { describe, expect, it } from 'vitest'
import { matchHttpRoute } from '../src/inbound/http-routes.js'

describe('public HTTP route boundary', () => {
  it('keeps token gateways and health on their own entry routes', () => {
    expect(matchHttpRoute('POST', '/_dsh-phalanx/model/v1/messages')).toMatchObject({
      id: 'model',
      identity: 'model-token',
      needsRuntimeRecords: false,
    })
    expect(matchHttpRoute('POST', '/_dsh-phalanx/service/firecrawl/v2/search')).toMatchObject({
      id: 'not-found',
      identity: 'public',
      needsRuntimeRecords: false,
    })
    for (const path of ['/_dsh-phalanx/web/v1/tools/search', '/_dsh-phalanx/web/v1/tools/fetch']) {
      expect(matchHttpRoute('POST', path)).toMatchObject({ id: 'web-tools', identity: 'model-token', needsRuntimeRecords: false })
      expect(matchHttpRoute('GET', path)).toMatchObject({ id: 'web-tools', identity: 'model-token' })
    }
    expect(matchHttpRoute('GET', '/healthz')).toMatchObject({
      id: 'health',
      identity: 'public',
      needsRuntimeRecords: false,
    })
  })

  it('keeps market APIs protected and retires the standalone page', () => {
    expect(matchHttpRoute('GET', '/market/api/experts')).toMatchObject({ id: 'market', identity: 'platform-user' })
    expect(matchHttpRoute('POST', '/market/api/experts')).toMatchObject({ id: 'market', identity: 'platform-user' })
    expect(matchHttpRoute('GET', '/market/api/skills')).toMatchObject({ id: 'market', identity: 'platform-user' })
    expect(matchHttpRoute('GET', '/market')).toMatchObject({ id: 'not-found', identity: 'public' })
    expect(matchHttpRoute('GET', '/market/')).toMatchObject({ id: 'not-found', identity: 'public' })
  })

  it('routes protected paths and unsupported methods through the existing runtime fallback', () => {
    expect(matchHttpRoute('GET', '/admin/api/accounts')).toMatchObject({ id: 'admin', identity: 'administrator' })
    expect(matchHttpRoute('POST', '/account/password')).toMatchObject({ id: 'not-found', identity: 'public' })
    expect(matchHttpRoute('PUT', '/login')).toMatchObject({ id: 'runtime', identity: 'platform-user' })
    expect(matchHttpRoute('POST', '/healthz')).toMatchObject({ id: 'runtime', identity: 'platform-user' })
  })
})
