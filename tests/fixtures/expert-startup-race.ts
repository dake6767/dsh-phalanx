import type { Page, Request } from 'playwright'

/** Hold the public startup handshakes until an expert launch can overlap them. */
export async function expertStartupRace(page: Page) {
  const controlOpened = handshake()
  const initialized = handshake()
  const releaseInitialization = handshake()
  const allowModel = handshake()
  const heldControl: (() => void)[] = []
  let controlReleased = false
  let initialization: Request | undefined
  let initializationAborted = false
  let expertSession: string | undefined
  const defaultReuses: string[] = []

  await page.routeWebSocket('**/api/remote.mux', socket => {
    const server = socket.connectToServer()
    socket.onMessage(message => {
      const frame = JSON.parse(String(message)) as { type?: string; endpoint?: string }
      if (!controlReleased && frame.type === 'open' && frame.endpoint === 'session/control') {
        heldControl.push(() => server.send(message))
        controlOpened.resolve()
      } else server.send(message)
    })
    server.onMessage(message => socket.send(message))
  })
  page.on('requestfailed', request => {
    if (request === initialization) {
      initializationAborted = true
      allowModel.resolve()
    }
  })
  await page.route('**/api/workspace/initializeDefault', async route => {
    if (initialization) {
      await route.continue()
      return
    }
    initialization = route.request()
    const response = await route.fetch()
    initialized.resolve()
    await releaseInitialization.promise
    if (route.request().failure()) return
    await route.fulfill({ response })
  })
  await page.route('**/api/phalanx.expert-conversation', async route => {
    const response = await route.fetch()
    const result = (await response.json()) as { sessionId?: string }
    await route.fulfill({ response })
    if (response.ok() && result.sessionId) {
      expertSession = result.sessionId
      releaseInitialization.resolve()
    }
  })
  await page.route('**/api/session/create', async route => {
    const request = route.request().postDataJSON().payload.args.request as { agentPreset?: string; sessionId?: string }
    const response = await route.fetch()
    const result = (await response.json()).result as { ok: boolean; value?: { sessionId: string } }
    await route.fulfill({ response })
    if (request.agentPreset?.startsWith('phalanx-expert-') && result.ok) {
      expertSession = result.value!.sessionId
      releaseInitialization.resolve()
    } else if (expertSession && request.sessionId === expertSession && request.agentPreset === undefined) {
      defaultReuses.push(expertSession)
      allowModel.resolve()
    }
  })
  await page.route('**/api/session/selectModel', async route => {
    await allowModel.promise
    await route.continue()
  })
  return {
    controlOpened: controlOpened.promise,
    initialized: initialized.promise,
    releaseControl: () => {
      controlReleased = true
      for (const send of heldControl.splice(0)) send()
    },
    initializationAborted: () => initializationAborted,
    defaultReuses: () => [...defaultReuses],
  }
}

function handshake() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
