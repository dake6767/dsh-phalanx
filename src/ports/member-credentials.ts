/** System credentials in one currently running member instance. Values are personal secrets or scoped platform access tokens. */
export interface MemberCredentialsPort {
  lookup(attributes: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string | undefined>
  store(attributes: Readonly<Record<string, string>>, value: string, signal?: AbortSignal): Promise<void>
  clear(attributes: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<void>
}
