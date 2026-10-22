import { Go2rtcClient } from '@/lib/streams/go2rtc'

/**
 * The go2rtc on this machine (GO2RTC_URL, default http://127.0.0.1:1984), for server code that only tidies streams up (archive,
 * discovery: review P2-5b M-4). Undefined when the address is not a loopback one (the client refuses it): tidying is then skipped,
 * never an error for the person.
 */
export function localGo2rtc(): Go2rtcClient | undefined {
  try {
    return new Go2rtcClient(process.env.GO2RTC_URL ?? 'http://127.0.0.1:1984')
  } catch {
    return undefined
  }
}
