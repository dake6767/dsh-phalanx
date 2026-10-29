export interface McpWirePort {
  filter(response: Response, filter: (value: unknown) => Promise<unknown>): Promise<Response>
  reply(response: Response, id: number): Promise<Record<string, unknown>>
}
