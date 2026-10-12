export interface McpWirePort {
  filter(response: Response, filter: (value: unknown) => unknown): Response
  reply(response: Response, id: number): Promise<Record<string, unknown>>
}
