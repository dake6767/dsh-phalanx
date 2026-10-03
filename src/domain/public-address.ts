// Platform category: exclude private, documentation, benchmark, multicast and
// special/reserved space. Source: https://www.iana.org/assignments/iana-ipv4-special-registry/
const NON_PUBLIC = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.31.196.0/24', '192.52.193.0/24', '192.88.99.0/24', '192.168.0.0/16',
  '192.175.48.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4']

export function ipv4Number(address: string): number | undefined {
  const parts = address.split('.')
  if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9]\d{0,2})$/u.test(part) || Number(part) > 255)) return undefined
  return parts.reduce((value, part) => value * 256 + Number(part), 0)
}

export function addressInNetwork(address: string, network: string): boolean {
  const [base, bits = '32', extra] = network.split('/')
  const target = base === undefined ? undefined : ipv4Number(base)
  const ip = ipv4Number(address)
  const prefix = Number(bits)
  if (extra !== undefined || ip === undefined || target === undefined || !/^\d+$/u.test(bits) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
  const divisor = 2 ** (32 - prefix)
  return Math.floor(ip / divisor) === Math.floor(target / divisor)
}

export function isPublicIPv4(address: string): boolean {
  return ipv4Number(address) !== undefined && !NON_PUBLIC.some(network => addressInNetwork(address, network))
}
