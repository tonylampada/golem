import { useEffect, useState } from 'react'
import { jobs, type JobRun, type SystemSchedule } from '../client'

const when = (value?: string | null) => value ? new Date(value).toLocaleString() : '—'

/** Admins: the app's system schedules (declared in code) and user schedules whose owner was removed. */
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
  const button = 'rounded border border-neutral-300 px-2 py-1'
  return (
    <section className="golem-browser-system-jobs mx-auto w-full max-w-2xl p-4 text-sm">
      <h2 className="font-semibold">Scheduled jobs</h2>
      <p className="mt-1 text-neutral-500">System schedules run as System and change only in code. Schedules whose owner was removed no longer run.</p>
      {!schedules.length && <p className="mt-3 text-neutral-500">No system schedules.</p>}
      {schedules.map((schedule) => (
        <article key={schedule.id} className="golem-browser-system-job mt-3 rounded border border-neutral-200 p-3" data-owner={schedule.owner}>
          <div className="flex flex-wrap items-center gap-2">
            <strong>{schedule.job}</strong>
            {schedule.owner === 'removed' && <span className="rounded bg-amber-100 px-2 text-amber-800">owner removed</span>}
            {schedule.paused && <span className="rounded bg-neutral-100 px-2 text-neutral-600">paused</span>}
            <code className="text-neutral-600">{schedule.cron ?? `every ${schedule.every}s`}{schedule.timezone ? ` · ${schedule.timezone}` : ''}</code>
          </div>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-neutral-500">Next run</dt><dd>{schedule.owner === 'removed' || schedule.paused ? '—' : when(schedule.nextRunAt)}</dd>
            <dt className="text-neutral-500">Last run</dt>
            <dd>{schedule.lastRun ? <>{when(schedule.lastRun.startedAt)} · <span data-status={schedule.lastRun.status}>{schedule.lastRun.status}</span></> : 'never'}</dd>
            {(schedule.lastRun?.error || schedule.error) && <><dt className="text-neutral-500">Error</dt><dd className="break-words text-red-700">{schedule.lastRun?.error ?? schedule.error}</dd></>}
          </dl>
          <div className="mt-2 flex flex-wrap gap-2">
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
            <ul className="mt-2 grid gap-1">
              {!runs.length && <li className="text-neutral-500">No runs yet.</li>}
              {runs.map((run) => (
                <li key={run.id} className="flex flex-wrap gap-2" data-status={run.status}>
                  <span>{when(run.startedAt)}</span>
                  <span>{run.status}{run.resolution ? `, ${run.resolution}` : ''}</span>
                  {run.startedBy && <span className="text-neutral-500">by {run.startedBy}</span>}
                  {run.error && <span className="break-words text-red-700">{run.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
      {error && <p className="golem-browser-error mt-3 text-red-700">{error}</p>}
    </section>
  )
}
