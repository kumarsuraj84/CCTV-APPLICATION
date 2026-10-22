// The live wall (/live) exists, so the groups screens link to it. Set this to false to hide those links.
export const LIVE_WALL_ENABLED: boolean = true

export const liveWallHref = (groupId: string): string => `/live?group=${encodeURIComponent(groupId)}`
