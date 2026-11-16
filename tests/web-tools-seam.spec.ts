import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { DEEPSEEK_WEB_TOOLS_BASE_URL, isDeploymentWebToolsBaseUrl } from '../src/dsh/web-tools.js'

describe('web retrieval seam binding', () => {
  it('uses a loopback-only endpoint for account notifications', () => {
    const overlay = parse(readFileSync('runtime/community.cordis.yml', 'utf8'), {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
    })
    expect(overlay).toContainEqual({
      id: 'deepseek-account',
      config: { desktopPlatform: null, allowLoopbackHttp: true, harnessOrigin: 'http://127.0.0.1:1' },
    })
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
