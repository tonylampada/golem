import type { AppServerModule } from 'golem-kit/server'
import { generate } from './generate.ts'
import { archive } from './notes.ts'

export default {
  operations: [archive, generate],
  jobs: [
    { name: 'sample-notes', description: 'Write a batch of sample notes.', operation: 'notes.generate' },
    // A system schedule: declared here, kept by golem, run as the System principal, paused or run by admins.
    { name: 'nightly-sample', description: 'Write one sample note every night.', operation: 'notes.generate', schedule: { cron: '0 3 * * *', timezone: 'UTC', input: { count: 1, delayMs: 0 } } },
  ],
  authorize: ({ operation, record, principal }) => {
    // Viewers, when the app has accounts, read but never generate notes; a job run checks this on every run.
    if (operation === 'notes.generate' && principal.kind === 'user' && principal.roles.includes('viewer')) return false
    // A locked note can be read and listed but not changed, by any caller path.
    return !(record?.locked === true && !['records.get', 'records.list'].includes(operation))
  },
} satisfies AppServerModule
