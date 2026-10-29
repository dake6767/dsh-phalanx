import { BusinessRuleError } from './business-error.js'

export function assertPluginGroupConfiguration(controlled: readonly string[], preinstalled: readonly string[]): void {
  if (controlled.some(name => preinstalled.includes(name)))
    throw new BusinessRuleError('invalid', 'A plugin can belong to only one group list.', 'plugin-grant-invalid')
}
