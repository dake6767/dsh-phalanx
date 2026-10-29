import { expect, it } from 'vitest'
import { startCommunityModel } from './fixtures/community-model.js'

it('answers both legacy and current official title requests without waiting for the chat gate', async () => {
  const model = await startCommunityModel()
  try {
    for (const body of [
      { max_tokens: 64, messages: [{ role: 'user', content: 'A title' }] },
      { max_tokens: 256, messages: [{ role: 'user', content: 'Generate the session title from this JSON array of human messages:\n[{"text":"hello"}]' }] },
    ]) {
      const response = await fetch(model.origin + '/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'community-provider-fixture-key', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      })
      expect(await response.text()).toContain('COMMUNITY_TITLE')
    }
  } finally {
    await model.close()
  }
})
