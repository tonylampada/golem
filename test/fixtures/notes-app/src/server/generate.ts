import { setTimeout as sleep } from 'node:timers/promises'
import { defineOperation, z } from 'golem-kit/server'

/** Writes numbered sample notes slowly, so a run can be watched, cancelled or cut off by a restart. */
export const generate = defineOperation({
  name: 'notes.generate',
  description: 'Write a batch of numbered sample notes.',
  input: z.object({ count: z.number().int().min(1).max(20), delayMs: z.number().int().min(0).max(5000).default(500) }),
  output: z.object({ written: z.number() }),
  async run(input, { records, job }) {
    const batch = job?.key ?? crypto.randomUUID()
    for (let index = 0; index < input.count; index++) {
      await sleep(input.delayMs, undefined, { signal: job?.signal })
      // The run's key makes the ids stable, so a retry of the same run skips notes already written.
      const id = `${batch}-${index}`
      if (!(await records.get('notes', id))) await records.create('notes', { id, title: `Sample ${index + 1} of ${input.count}` })
      await job?.progress({ done: index + 1, total: input.count })
    }
    return { written: input.count }
  },
})
