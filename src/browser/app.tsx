import { Chat, Shell } from 'golem-ui'
import { anonymousIdentity, chat, navigation } from './adapters'

const shellAdapters = { identity: anonymousIdentity, navigation }
const chatAdapters = { chat }

export function App() {
  return (
    <Shell
      config={{ title: 'Golem', chatSide: 'left', breakpoint: 768 }}
      adapters={shellAdapters}
      chat={<Chat config={{ agentName: 'Golem agent', emptyState: 'No agent is connected yet.' }} adapters={chatAdapters} />}
      canvas={
        <section className="flex h-full min-h-64 items-center justify-center bg-neutral-50 p-6 text-center">
          <div>
            <h1 className="text-lg font-semibold">Canvas</h1>
            <p className="mt-2 text-sm text-neutral-500">The agent workspace will appear here.</p>
          </div>
        </section>
      }
      account={<span className="shrink-0 text-sm text-neutral-500">Guest</span>}
    />
  )
}
