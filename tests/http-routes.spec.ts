import { describe, expect, it } from 'vitest'
import { matchHttpRoute } from '../src/inbound/http-routes.js'

describe('public HTTP route boundary', () => {
  it('keeps token gateways and health on their own entry routes', () => {
    expect(matchHttpRoute('POST', '/_dsh-phalanx/model/v1/messages')).toMatchObject({
      id: 'model', identity: 'model-token', needsRuntimeRecords: false,
    })
    expect(matchHttpRoute('POST', '/_dsh-phalanx/service/firecrawl/v2/search')).toMatchObject({
      id: 'not-found', identity: 'public', needsRuntimeRecords: false,
    })
    expect(matchHttpRoute('GET', '/healthz')).toMatchObject({
      id: 'health', identity: 'public', needsRuntimeRecords: false,
    })
  })

  it('routes protected paths and unsupported methods through the existing runtime fallback', () => {
    expect(matchHttpRoute('GET', '/admin/api/accounts')).toMatchObject({ id: 'admin', identity: 'administrator' })
    expect(matchHttpRoute('POST', '/account/password')).toMatchObject({ id: 'not-found', identity: 'public' })
    expect(matchHttpRoute('PUT', '/login')).toMatchObject({ id: 'runtime', identity: 'platform-user' })
    expect(matchHttpRoute('POST', '/healthz')).toMatchObject({ id: 'runtime', identity: 'platform-user' })
  })
})
