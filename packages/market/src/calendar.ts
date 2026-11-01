// NYSE published 2026–2027 equity calendar. Outside coverage is UNKNOWN.
// https://www.nyse.com/trade/hours-calendars
const holidays = new Set([
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
  '2027-01-01',
  '2027-01-18',
  '2027-02-15',
  '2027-03-26',
  '2027-05-31',
  '2027-06-18',
  '2027-07-05',
  '2027-09-06',
  '2027-11-25',
  '2027-12-24',
]);
const early = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);
export function equitySession(
  utc: string,
): 'PRE' | 'REGULAR' | 'POST' | 'CLOSED' | 'UNKNOWN' {
  const d = new Date(utc);
  if (!Number.isFinite(d.getTime())) return 'UNKNOWN';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(d);
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? '';
  if (!['2026', '2027'].includes(get('year'))) return 'UNKNOWN';
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  if (['Sat', 'Sun'].includes(get('weekday')) || holidays.has(day))
    return 'CLOSED';
  const m = Number(get('hour')) * 60 + Number(get('minute'));
  const close = early.has(day) ? 780 : 960;
  if (m < 240 || m >= (early.has(day) ? 1020 : 1200)) return 'CLOSED';
  if (m < 570) return 'PRE';
  if (m < close) return 'REGULAR';
  return 'POST';
}
