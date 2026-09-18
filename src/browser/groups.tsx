import { useEffect, useState } from 'react'
import { identity, setGroups, type Member } from '../client'

/** Group membership beside golem-ui's member list, which edits roles but not groups. */
export function Groups() {
  const [members, setMembers] = useState<Member[]>([])
  const [error, setError] = useState<string>()
  const load = () => identity.listMembers().then((list) => setMembers(list as Member[]), (cause) => setError(String(cause?.message ?? cause)))
  useEffect(() => { void load() }, [])
  const save = async (member: Member, text: string) => {
    setError(undefined)
    try { await setGroups(member.id, text.split(',').map((group) => group.trim()).filter(Boolean)); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return (
    <section className="golem-browser-groups mx-auto w-full max-w-sm p-4 text-sm">
      <h2 className="font-semibold">Groups</h2>
      <p className="mt-1 text-neutral-500">Comma-separated. App rules can check these.</p>
      {members.map((member) => (
        <form key={`${member.id}:${member.groups.join(',')}`} className="mt-3 flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void save(member, String(new FormData(event.currentTarget).get('groups') ?? '')) }}>
          <label className="w-28 truncate" htmlFor={`groups-${member.id}`}>{member.name}</label>
          <input id={`groups-${member.id}`} name="groups" defaultValue={member.groups.join(', ')} className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1" />
          <button type="submit" className="rounded border border-neutral-300 px-2 py-1">Save</button>
        </form>
      ))}
      {error && <p className="golem-browser-error mt-3 text-red-700">{error}</p>}
    </section>
  )
}
