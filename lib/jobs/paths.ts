// Setting-path helpers (P7-0).

/** Two setting paths conflict when they are equal or one contains the other (dot boundaries). */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`)
}
