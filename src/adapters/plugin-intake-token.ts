import { randomBytes } from 'node:crypto'

export const pluginIntakeToken = (): string => randomBytes(24).toString('hex')
