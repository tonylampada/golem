const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const pad = (value: string) => value.padStart(2, '0')
const number = (value: string, max: number) => /^\d+$/.test(value) && Number(value) <= max

/** A cron in words when it is one of the common shapes ("every day at 06:00"), else undefined and the raw cron speaks for itself. */
export function describeCron(cron: string): string | undefined {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return undefined
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string]
  if (month !== '*') return undefined
  const step = /^\*\/(\d+)$/
  if (hour === '*' && day === '*' && weekday === '*') {
    if (minute === '*') return 'every minute'
    const every = step.exec(minute)?.[1]
    if (every) return every === '1' ? 'every minute' : `every ${Number(every)} minutes`
    if (number(minute, 59)) return `every hour at :${pad(minute)}`
    return undefined
  }
  if (!number(minute, 59)) return undefined
  const everyHours = step.exec(hour)?.[1]
  if (everyHours && day === '*' && weekday === '*') return `every ${Number(everyHours)} hours at :${pad(minute)}`
  const hours = hour.split(',')
  if (!hours.every((one) => number(one, 23))) return undefined
  const at = `at ${hours.map((one) => `${pad(one)}:${pad(minute)}`).join(', ')}`
  if (day === '*' && weekday === '*') return `every day ${at}`
  if (day === '*') {
    if (weekday === '1-5') return `weekdays ${at}`
    if (weekday === '0,6' || weekday === '6,0') return `weekends ${at}`
    const days = weekday.split(',')
    if (!days.every((one) => number(one, 7))) return undefined
    return `every ${days.map((one) => DAYS[Number(one) % 7]).join(', ')} ${at}`
  }
  if (weekday === '*' && number(day, 31) && Number(day) > 0) return `every month on day ${Number(day)} ${at}`
  return undefined
}
