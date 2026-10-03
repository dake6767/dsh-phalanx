import type { ServerResponse } from 'node:http'
import { sendText } from './http-response.js'

/** Liveness is public and independent of runtime record recovery. */
export function handleHealth(response: ServerResponse): void {
  sendText(response, 200, 'ok')
}
