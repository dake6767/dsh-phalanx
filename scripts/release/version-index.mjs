import { compareVersions } from './compatibility.mjs'

/** Stable tag names are discovery only; installed readers verify each version's Release assets. */
export function releaseVersionIndex(version, tags) {
  return [
    ...new Set([...tags.filter(tag => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(tag) && compareVersions(tag.slice(1), version) <= 0), `v${version}`]),
  ].sort((left, right) => compareVersions(left.slice(1), right.slice(1)))
}
