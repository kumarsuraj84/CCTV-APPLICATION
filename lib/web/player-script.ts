// Final fix Y (final review B minor 5, decision D-12): go2rtc's player scripts are a pinned copy in the app itself
// (public/vendor/go2rtc-1.9.9/, the unchanged files of go2rtc 1.9.9, MIT licence; the same version as the pinned go2rtc image), loaded
// from the app's own origin with a subresource integrity hash. Before, the browser ran whatever answered on go2rtc's port behind the
// gateway (/g/video-stream.js) as a script of the app. video-stream.js imports ./video-rtc.js from the same folder; both files are
// pinned by tests/unit/player-script.test.ts (their SHA-384 must match these values; changing a file is a deliberate change here).

export const PLAYER_SCRIPT_DIR = '/vendor/go2rtc-1.9.9'
export const PLAYER_SCRIPT_SRC = `${PLAYER_SCRIPT_DIR}/video-stream.js`
export const PLAYER_SCRIPT_INTEGRITY = 'sha384-iod14hC4KCCn448pY8mX357Xh1whTxI1s1FNDUgXq3auCwRcmFR3XIVw7n5n4RTt'
/** The module video-stream.js imports (no integrity attribute is possible on a static import; pinned by the test instead). */
export const PLAYER_RTC_SHA384 = 'H+wweeZL/MuZVb/QFhFCYfMzNkySJL2x6RZnKdjCgTntpFjnTm1BEB1xVBAHemMX'

/** The address of the entry script; a retry gets its own address so a failed load is not served from the browser's cache. */
export const playerScriptUrl = (attempt = 0): string => `${PLAYER_SCRIPT_SRC}${attempt > 0 ? `?r=${attempt}` : ''}`
