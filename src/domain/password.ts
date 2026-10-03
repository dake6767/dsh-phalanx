import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
const KEY_BYTES = 64
const COST = 16_384
const BLOCK_SIZE = 8
const PARALLELIZATION = 1
const PREFIX = 'scrypt-v1'

/**
 * Hash a platform password for deployment configuration.
 * @param password - plaintext supplied by the operator.
 * @returns self-describing scrypt digest; the plaintext is not retained.
 */
export async function hashPassword(password: string): Promise<string> {
  if (password.length === 0) throw new Error('password must not be empty')
  const salt = randomBytes(16)
  const derived = await derive(password, salt)
  return [PREFIX, salt.toString('base64url'), derived.toString('base64url')].join('$')
}

/**
 * Verify a password against a dsh-phalanx deployment digest.
 * @param password - candidate plaintext from the login form.
 * @param encoded - digest produced by {@link hashPassword}.
 * @returns whether the candidate matches.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [prefix, saltText, digestText, extra] = encoded.split('$')
  if (prefix !== PREFIX || saltText === undefined || digestText === undefined || extra !== undefined) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(saltText, 'base64url')
    expected = Buffer.from(digestText, 'base64url')
  } catch {
    return false
  }
  if (salt.byteLength !== 16 || expected.byteLength !== KEY_BYTES) return false
  const actual = await derive(password, salt)
  return timingSafeEqual(actual, expected)
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolveKey, reject) => {
    scryptCallback(password, salt, KEY_BYTES, {
      N: COST,
      r: BLOCK_SIZE,
      p: PARALLELIZATION,
      maxmem: 32 * 1024 * 1024,
    }, (error, key) => {
      if (error !== null) reject(error)
      else resolveKey(key)
    })
  })
}
