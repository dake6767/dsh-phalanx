/** Blank fields mean "skip" in the wizard and "keep the saved value" in the details. */
export function filledCredentials(values: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim() !== ''))
}
