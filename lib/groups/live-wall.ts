// The live wall page arrives with a later task. Until then no link to it is shown, so nobody lands on a missing page.
// Switch this to true when `/live` exists.
export const LIVE_WALL_ENABLED: boolean = false

export const liveWallHref = (groupId: string): string => `/live?group=${encodeURIComponent(groupId)}`
