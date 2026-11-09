/** Entry points paused for this release; data and background behavior remain active. */
export const hiddenFeatures: readonly string[] = Object.freeze(['experts', 'usage', 'contributions'])

export function featureVisible(feature: string): boolean {
  return !hiddenFeatures.includes(feature)
}
