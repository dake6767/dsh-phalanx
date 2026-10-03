import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, BrowserContext } from 'playwright'
import type { TestContext } from 'vitest'

const evidenceRoot = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
const traced = new Set<BrowserContext>()

export async function newValidationContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ locale: 'en-US' })
  if (evidenceRoot !== undefined) traced.add(context)
  return context
}

export async function saveBrowserEvidence(test: TestContext): Promise<void> {
  if (evidenceRoot === undefined) return
  const failed = test.task.result?.state === 'fail'
  const name = test.task.name.replace(/[^a-zA-Z0-9-]/gu, '-').slice(0, 70)
  const directory = join(evidenceRoot, name)
  if (failed) await mkdir(directory, { recursive: true, mode: 0o700 })
  let index = 0
  for (const context of traced) {
    index += 1
    if (failed) {
      // Begin tracing only after the assertion has failed. Login requests and
      // session cookies from the test never enter the retained trace.
      for (const page of context.pages()) {
        await page.locator('input, textarea').evaluateAll(inputs => {
          for (const input of inputs) {
            if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
              input.value = ''
              input.removeAttribute('value')
              if (input instanceof HTMLTextAreaElement) input.textContent = ''
            }
          }
        }).catch(() => undefined)
      }
      await context.tracing.start({ screenshots: true, snapshots: false }).catch(() => undefined)
      for (const [pageIndex, page] of context.pages().entries()) {
        const fields = page.locator('input, textarea')
        await page.screenshot({ path: join(directory, `${index}-${pageIndex}.png`), fullPage: true, mask: [fields] }).catch(() => undefined)
      }
      await context.tracing.stop({ path: join(directory, `${index}.zip`) }).catch(() => undefined)
    }
  }
  traced.clear()
}
