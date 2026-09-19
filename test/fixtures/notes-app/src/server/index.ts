import type { AppServerModule } from 'golem-kit/server'
import { archive } from './notes.ts'

export default {
  operations: [archive],
  // A locked note can be read and listed but not changed, by any caller path.
  authorize: ({ operation, record }) => !(record?.locked === true && !['records.get', 'records.list'].includes(operation)),
} satisfies AppServerModule
