// P4-L2 review m-5: run by tests/unit/playback-timezones.test.ts in a child process with TZ set; prints the IST arithmetic of the
// Playback screen as JSON, plus the machine's own offset (to prove the TZ really applied).
import { dayLabel, dayNavigation, shownRecordedDays } from '@/lib/streams/calendar'
import { daySpans, formatShortDateTime, isPlayableStart, shiftTime, shownToday, startIsoAt } from '@/lib/streams/timeline'

const now = Date.UTC(2026, 9, 22, 18, 29, 0)
console.log(
  JSON.stringify({
    machineOffsetMin: new Date(Date.UTC(2026, 9, 22)).getTimezoneOffset(),
    todayBefore: shownToday(Date.UTC(2026, 9, 22, 18, 29, 59)),
    todayAfter: shownToday(Date.UTC(2026, 9, 22, 18, 30, 0)),
    jump: shiftTime('2026-10-22', 23 * 3600 + 58 * 60, 300),
    leap: shiftTime('2028-03-01', 10, -20),
    start: startIsoAt('2026-10-22', 45_296),
    spans: daySpans('2026-10-22', [{ start: '2026-10-21T23:30:00.000Z', end: '2026-10-22T00:45:00.000Z' }]),
    calendar: shownRecordedDays([{ year: 2026, month: 10, days: [3, 31] }], 5.5 * 3600_000, 2026, 10),
    label: dayLabel(2026, 10, 22),
    short: formatShortDateTime('2026-10-22T14:35:00.000Z'),
    playable: [isPlayableStart(Date.parse('2026-10-23T00:14:00Z'), now), isPlayableStart(Date.parse('2026-10-23T00:15:01Z'), now)],
    nav: dayNavigation('2025-10-01', '2026-10-22'),
  }),
)
