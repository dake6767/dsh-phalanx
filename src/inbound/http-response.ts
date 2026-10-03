import type { ServerResponse } from 'node:http'

export function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' })
  response.end(body)
}

export function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
  response.end(body)
}
