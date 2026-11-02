/**
 * One handler per member of a tagged union, with each handler given its member
 * already narrowed. A plain `Record<U['state'], (u: U) => R>` table loses the
 * narrowing, so each of its handlers would have to cast. `K` is the tag's
 * name, `state` unless the union says otherwise.
 */
export type Cases<U extends { [P in K]: string }, R, K extends string = 'state'> = {
  [S in U[K]]: (value: Extract<U, { [P in K]: S }>) => R
}

/** Runs the handler for `value`'s member of the union, picked by its `key` tag. */
export function caseOf<U extends { [P in K]: string }, K extends string, R>(value: U, key: K, cases: Cases<U, R, K>): R {
  // TypeScript cannot tie the tag it looked up to the member it narrows the handler to, so this is the one cast.
  const handle = cases[value[key]] as (value: U) => R
  return handle(value)
}
