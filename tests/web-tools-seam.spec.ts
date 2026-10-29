import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEEPSEEK_WEB_TOOLS_BASE_URL, WEB_TOOLS_GATEWAY_BASE_PATH, WEB_TOOLS_MEMBER_TOKEN_ENV, isDeploymentWebToolsBaseUrl } from '../src/dsh/web-tools.js'

describe('web retrieval seam binding', () => {
  it('binds the deployed overlay literals to the seam owner constants', () => {
    const overlay = readFileSync('runtime/community.cordis.yml', 'utf8')
    expect(overlay).toContain(`new URL('${WEB_TOOLS_GATEWAY_BASE_PATH}'`)
    expect(overlay).toContain(`apiKeyEnv: ${WEB_TOOLS_MEMBER_TOKEN_ENV}`)
  })

  it('accepts only the official HTTPS destination on its default port', () => {
    expect(isDeploymentWebToolsBaseUrl(DEEPSEEK_WEB_TOOLS_BASE_URL)).toBe(true)
    expect(isDeploymentWebToolsBaseUrl('https://api.deepseek.com:443/v1/tools')).toBe(true)
    expect(isDeploymentWebToolsBaseUrl('http://api.deepseek.com/v1/tools')).toBe(false)
    expect(isDeploymentWebToolsBaseUrl('https://api.deepseek.com:8443/v1/tools')).toBe(false)
    expect(isDeploymentWebToolsBaseUrl('https://proxy.example.test/v1/tools')).toBe(false)
    expect(isDeploymentWebToolsBaseUrl('not-a-url')).toBe(false)
  })
})
