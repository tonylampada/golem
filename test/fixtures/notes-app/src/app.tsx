import { useState } from 'react'
import { RecordForm, RecordList, Upload } from 'golem-ui'
import { files, invoke, records } from 'golem-kit/client'

const fields = [
  { key: 'title', label: 'Title', type: 'text' as const, required: true },
  { key: 'body', label: 'Body', type: 'text' as const, multiline: true },
]

export default function App() {
  const [editing, setEditing] = useState<string>()
  const [message, setMessage] = useState<string>()
  const archive = async () => {
    try { setMessage((await invoke<{ message: string }>('notes.archive', { id: editing })).message) }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }
  return (
    <main className="grid gap-6 p-6">
      <RecordList config={{ collection: 'notes', fields: [{ key: 'title', label: 'Title', type: 'text', primary: true }, { key: 'archived', label: 'Archived', type: 'boolean' }], rowAction: 'open' }} adapters={{ records }} onOpen={(row) => { setEditing(String(row.id)); setMessage(undefined) }} />
      {editing
        ? <section className="grid gap-2">
            <RecordForm key={editing} config={{ collection: 'notes', fields, mode: 'edit', cancel: 'back' }} adapters={{ records }} recordId={editing} onDone={() => setEditing(undefined)} onCancel={() => setEditing(undefined)} />
            <button className="notes-archive justify-self-start rounded border px-3 py-1" onClick={archive}>Archive</button>
          </section>
        : <RecordForm config={{ collection: 'notes', fields, mode: 'create', submitLabel: 'Add note' }} adapters={{ records }} />}
      {message && <p className="notes-message">{message}</p>}
      <Upload config={{ folder: 'attachments', captions: true, layout: 'list' }} adapters={{ files }} />
    </main>
  )
}
