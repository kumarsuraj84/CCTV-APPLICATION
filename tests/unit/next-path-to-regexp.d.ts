// The copy of path-to-regexp that Next.js itself uses to match `redirects` (no types are shipped with it). Only what tests/unit/old-store-urls.test.ts needs.
declare module 'next/dist/compiled/path-to-regexp' {
  export function match(path: string): (pathname: string) => false | { path: string; params: Record<string, string | string[]> }
  export function compile(path: string): (params: Record<string, string | string[]>) => string
}
