/** Source ranges are release policy; target versions come from the packaged registry. */
export function releaseCompatibility(policy, inventory) {
  if (!Array.isArray(inventory) || inventory[0]?.name !== 'dsh_phalanx' || !Array.isArray(policy.schemas) || inventory.length !== policy.schemas.length)
    throw new Error('Release policy must cover the exact packaged schema inventory')
  const names = new Set()
  const schemas = inventory.map((schema, index) => {
    const range = policy.schemas[index]
    if (
      names.has(schema.name) ||
      range?.name !== schema.name ||
      Object.hasOwn(range, 'target') ||
      !Number.isSafeInteger(schema.target) ||
      schema.target < 1 ||
      !Number.isSafeInteger(range.sourceMin) ||
      range.sourceMin < 0 ||
      !Number.isSafeInteger(range.sourceMax) ||
      range.sourceMax < range.sourceMin ||
      range.sourceMax > schema.target
    )
      throw new Error('Invalid or duplicated release schema range')
    names.add(schema.name)
    return { ...range, target: schema.target }
  })
  const accounts = Object.fromEntries(['sourceMin', 'sourceMax', 'target'].map(key => [key, schemas[0][key]]))
  return { ...policy, schemas, accounts }
}
