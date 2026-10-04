import { expect, it } from 'vitest'
import { privateLaunchUrl } from '../src/dsh/readiness.js'

it('exchanges an advertised TLS mount token only through its private listener', () => {
  const advertised = new URL('https://example.test:18443/app/fixture-space/')
  expect(privateLaunchUrl(`${advertised.href}?token=fixture`, advertised, 4180).href).toBe('http://127.0.0.1:4180/?token=fixture')
  for (const ready of [
    'https://example.test:18443/app/other-space/?token=fixture',
    'https://other.test:18443/app/fixture-space/?token=fixture',
    `${advertised.href}?token=one&token=two`,
    `${advertised.href}`,
  ]) expect(() => privateLaunchUrl(ready, advertised, 4180)).toThrow()
})
