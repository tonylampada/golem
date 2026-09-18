import { defineOperation, z, type AppServerModule } from 'golem-kit/server'
import type { Note } from '../shared/notes.ts'

const archive = defineOperation({
  name: 'notes.archive',
  description: 'Archive one note so it leaves the active list.',
  input: z.object({ id: z.string() }),
  output: z.object({ id: z.string(), archived: z.boolean(), version: z.number() }),
  record: (input) => ({ collection: 'notes', id: input.id }),
  async run(input, { records }) {
    const note = await records.update('notes', input.id, { archived: true }) as unknown as Note
    return { id: note.id, archived: true, version: note.version }
  },
})

export default {
  operations: [archive],
  // A locked note can be read and listed but not changed, by any caller path.
  authorize: ({ operation, record }) => !(record?.locked === true && !['records.get', 'records.list'].includes(operation)),
} satisfies AppServerModule
