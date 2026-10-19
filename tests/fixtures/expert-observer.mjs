import { apply as observe, inject as observerInject } from './skill-observer.mjs'
export const name = 'expert-acceptance-observer'
export const inject = [...observerInject, 'systemPrompt']
export function apply(ctx) {
  observe(ctx)
  ctx.effect(() => ctx.systemPrompt.section({ name: 'expert-fixture:platform-guide', order: 100, text: 'GLOBAL_PLATFORM_GUIDE' }), 'expert-fixture.guide')
}
