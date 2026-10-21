// PostgREST returns at most 1000 rows per request. This reads page after page until a short page comes back.
export async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1)
    if (error) throw new Error('Could not read all rows.')
    const page = data ?? []
    out.push(...page)
    if (page.length < pageSize) return out
  }
}
