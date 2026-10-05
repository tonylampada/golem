import { useEffect, useState } from 'react'
import { jobs, type JobRun, type SystemSchedule } from '../client'
import { describeCron } from './cron'

const when = (value?: string | null) => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

function Pill({ status }: { status: string }) {
  return <span className="golem-browser-pill" data-status={status}>{status}</span>
}

/** Admins: the app's system schedules (declared in code) and user schedules whose owner was removed. One compact card each, phone first. */
export function SystemJobs() {
  const [schedules, setSchedules] = useState<SystemSchedule[]>([])
  const [open, setOpen] = useState<string>()
  const [runs, setRuns] = useState<JobRun[]>([])
  const [error, setError] = useState<string>()
  const load = () => jobs.admin.list().then(({ schedules: next }) => setSchedules(next), (cause: Error) => setError(cause.message))
  useEffect(() => { void load(); return jobs.subscribe(() => void load()) }, [])
  useEffect(() => {
    if (!open) return
    const read = () => void jobs.admin.runs({ scheduleId: open, limit: 10 }).then(setRuns, (cause: Error) => setError(cause.message))
    read()
    return jobs.subscribe(read)
  }, [open])
  const act = (action: () => Promise<unknown>) => () => { setError(undefined); void action().then(load, (cause: Error) => setError(cause.message)) }
  const button = 'golem-browser-job-action rounded border px-2 py-0.5 text-xs'
  return (
    <section className="golem-browser-system-jobs mx-auto w-full max-w-2xl p-4 text-sm">
      <h2 className="font-semibold">Scheduled jobs</h2>
      <p className="golem-browser-muted mt-1 text-xs">System schedules run as System and change only in code. Schedules whose owner was removed no longer run.</p>
      {!schedules.length && <p className="golem-browser-muted mt-3">No system schedules.</p>}
      {schedules.map((schedule) => {
        const words = schedule.cron ? describeCron(schedule.cron) : `every ${schedule.every}s`
        const failure = schedule.lastRun?.error ?? schedule.error
        const idle = schedule.owner === 'removed' || schedule.paused
        return (
          <article key={schedule.id} className="golem-browser-system-job mt-3 rounded-lg border p-3" data-owner={schedule.owner}>
            <div className="flex flex-wrap items-center gap-2">
              <strong className="min-w-0 break-words">{schedule.job}</strong>
              {schedule.owner === 'removed' && <Pill status="owner removed" />}
              {schedule.paused && <Pill status="paused" />}
            </div>
            <p className="mt-0.5">
              {words ?? schedule.cron}{schedule.timezone ? `, ${schedule.timezone}` : ''}
              {words && schedule.cron && <code className="golem-browser-muted ml-2 whitespace-nowrap text-xs">{schedule.cron}</code>}
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-x-2"><span className="golem-browser-muted w-9">Next</span>{idle ? '—' : when(schedule.nextRunAt)}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2"><span className="golem-browser-muted w-9">Last</span>{schedule.lastRun ? <>{when(schedule.lastRun.startedAt)} <Pill status={schedule.lastRun.status} /></> : 'never'}</p>
            {failure && <p className="golem-browser-error mt-2 break-words text-xs text-red-700">{failure}</p>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {schedule.owner === 'system' ? <>
                <button type="button" className={button} onClick={act(() => jobs.admin.pause(schedule.id, !schedule.paused))}>{schedule.paused ? 'Resume' : 'Pause'}</button>
                <button type="button" className={button} onClick={act(() => jobs.admin.run(schedule.id))}>Run now</button>
                {schedule.lastRun && ['failed', 'cancelled', 'interrupted'].includes(schedule.lastRun.status) && (
                  <button type="button" className={button} onClick={act(() => jobs.admin.retry(schedule.lastRun!.id))}>Retry</button>
                )}
                <button type="button" className={button} onClick={() => setOpen(open === schedule.id ? undefined : schedule.id)}>{open === schedule.id ? 'Hide runs' : 'Recent runs'}</button>
              </> : <button type="button" className={button} onClick={act(() => jobs.admin.remove(schedule.id))}>Delete</button>}
            </div>
            {open === schedule.id && (
              <ul className="mt-2 grid gap-1 text-xs">
                {!runs.length && <li className="golem-browser-muted">No runs yet.</li>}
                {runs.map((run) => (
                  <li key={run.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span>{when(run.startedAt)}</span>
                    <Pill status={run.status} />
                    {run.resolution && <span className="golem-browser-muted">{run.resolution}</span>}
                    {run.startedBy && <span className="golem-browser-muted">by {run.startedBy}</span>}
                    {run.error && <span className="golem-browser-error w-full break-words text-red-700">{run.error}</span>}
                  </li>
                ))}
              </ul>
            )}
          </article>
        )
      })}
      {error && <p className="golem-browser-error mt-3 text-red-700">{error}</p>}
    </section>
  )
}
