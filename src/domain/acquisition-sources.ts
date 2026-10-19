/** Each independent acquisition path contributes names; managed access wins display precedence. */
export interface AcquisitionSource {
  readonly source: 'managed' | 'selected'
  readonly names: readonly string[]
}

/** Recompute from current sources so withdrawing one path preserves all remaining paths. */
export function combineAcquisitionSources(sources: readonly AcquisitionSource[]): ReadonlyMap<string, AcquisitionSource['source']> {
  const acquired = new Map<string, AcquisitionSource['source']>()
  for (const { source, names } of sources) for (const name of names) {
    if (acquired.get(name) !== 'managed') acquired.set(name, source)
  }
  return acquired
}
