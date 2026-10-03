/** Fixed host ports shared by serial real DSH suites. */
export function realDshTestPorts(base: number) {
  if (!Number.isInteger(base) || base < 1024 || base + 19 > 65535) {
    throw new Error('invalid real DSH test port range')
  }
  return {
    gateway: base + 1,
  } as const
}
