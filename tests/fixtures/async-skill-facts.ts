/** Real Promise boundaries for lightweight in-memory skill fixtures. */
type AsyncMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : T[K]
}

export function asyncSkillFacts<T extends object>(facts: T): AsyncMethods<T> {
  return new Proxy(facts, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      return typeof value === 'function' ? async (...args: unknown[]) => await Reflect.apply(value, target, args) : value
    },
  }) as AsyncMethods<T>
}

export function asyncSkillPackFacts<S extends object, G extends object, C extends object>(facts: { store: S; grants: G; selections: C }) {
  return { store: asyncSkillFacts(facts.store), grants: asyncSkillFacts(facts.grants), selections: asyncSkillFacts(facts.selections) }
}
