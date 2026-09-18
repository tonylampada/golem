import { useEffect, useState } from 'react'
import { jobs, type JobRun, type JobSchedule } from 'golem-kit/client'

const input = { count: 5, delayMs: 800 }

/** Starts and schedules the sample-notes job and shows its runs; runs carry on when this page closes. */
export function SampleJobs() {
  const [runs, setRuns] = useState<JobRun[]>([])
  const [schedules, setSchedules] = useState<JobSchedule[]>([])
  const [error, setError] = useState<string>()
  const refresh = () => Promise.all([jobs.runs({ limit: 10 }), jobs.list()]).then(([next, listed]) => { setRuns(next); setSchedules(listed.schedules) }, (failure: Error) => setError(failure.message))
  useEffect(() => { void refresh(); return jobs.subscribe(() => void refresh()) }, [])
  const act = (action: () => Promise<unknown>) => () => { setError(undefined); void action().catch((failure: Error) => setError(failure.message)) }
  return (
    <section className="sample-jobs grid gap-2 rounded border p-3">
      <div className="flex flex-wrap gap-2">
        <button className="rounded border px-3 py-1" onClick={act(() => jobs.start('sample-notes', input))}>Generate samples</button>
        <button className="rounded border px-3 py-1" onClick={act(() => jobs.schedule('sample-notes', { every: 30 }, input))}>Every 30 seconds</button>
        {schedules.map((one) => (
          <button key={one.id} className="rounded border px-3 py-1" onClick={act(() => jobs.unschedule(one.id))}>Stop schedule (next {new Date(one.nextRunAt).toLocaleTimeString()})</button>
        ))}
      </div>
      {error && <p className="jobs-error">{error}</p>}
      <ul className="grid gap-1">
        {runs.map((run) => (
          <li key={run.id} className="job-run flex flex-wrap items-center gap-2" data-status={run.status}>
            <span>{run.status}{run.cancelRequested && run.status === 'running' ? ' (cancelling)' : ''}{run.resolution ? `, ${run.resolution}` : ''}</span>
            {run.progress && <progress max={run.progress.total} value={run.progress.done} />}
            {run.progress && <span>{run.progress.done}/{run.progress.total}</span>}
            {run.error && <span className="job-error">{run.error}</span>}
            {run.status === 'running' && !run.cancelRequested && <button className="rounded border px-2" onClick={act(() => jobs.cancel(run.id))}>Cancel</button>}
            {run.status === 'interrupted' && !run.resolution && <>
              <button className="rounded border px-2" onClick={act(() => jobs.resolve(run.id, 'retry'))}>Retry</button>
              <button className="rounded border px-2" onClick={act(() => jobs.resolve(run.id, 'dismiss'))}>Dismiss</button>
            </>}
          </li>
        ))}
      </ul>
    </section>
  )
}
