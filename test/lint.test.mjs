import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const frameworkRoot = fileURLToPath(new URL('..', import.meta.url))

function app(files) {
  const root = mkdtempSync(join(tmpdir(), 'golem-lint-'))
  writeFileSync(join(root, 'package.json'), '{"dependencies":{"golem-kit":"0.1.0"}}\n')
  assert.equal(spawnSync(process.execPath, [cli, 'init'], { cwd: root, encoding: 'utf8' }).status, 0)
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  symlinkSync(frameworkRoot, join(root, 'node_modules/golem-kit'), 'dir')
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  return root
}

function lint(root) {
  return spawnSync(process.execPath, [cli, 'lint'], { cwd: root, encoding: 'utf8' })
}

const adapters = {
  'src/shared/note.ts': 'export type Note = { id: string; body: string }\n',
  'src/server/persistence/notes.ts': "import pg from 'pg'\nimport { DatabaseSync } from 'node:sqlite'\nexport const open = (url: string) => new pg.Pool({ connectionString: url })\nexport const cast = <string>'typed'\n",
  'src/server/index.ts': "import { readFileSync } from 'node:fs'\nimport { open } from './persistence/notes.ts'\nimport type { Note } from '../shared/note.ts'\nexport const notes: Note[] = []\n",
  'src/notes.tsx': "import type { Note } from './shared/note.ts'\nexport const Row = <T,>(props: { note: Note; extra?: T }) => <li>{props.note.body}</li>\n",
}

test('starter and intended adapter imports pass the shared lint', { timeout: 30000 }, () => {
  const root = app(adapters)
  try {
    const result = lint(root)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /Architecture lint passed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('forbidden driver and server imports fail', { timeout: 30000 }, () => {
  const root = app({
    ...adapters,
    'src/app.tsx': "import pg from 'pg'\nexport default function App() { return <main /> }\n",
    'src/ui/list.tsx': "import type { Note } from '../server/index.ts'\nimport { readFileSync } from 'node:fs'\nimport { thing } from 'golem-kit/server'\nexport const List = (props: { notes: Note[] }) => <ul />\n",
    'src/server/report.ts': "export { MongoClient } from 'mongodb'\n",
  })
  try {
    const result = lint(root)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stdout, /app\.tsx[\s\S]*'pg'[\s\S]*Storage drivers belong in persistence adapters/)
    assert.match(result.stdout, /'\.\.\/server\/index\.ts'[\s\S]*cannot import backend modules/)
    assert.match(result.stdout, /'node:fs'[\s\S]*Node built-ins are server-only/)
    assert.match(result.stdout, /'golem-kit\/server'[\s\S]*Server-only modules/)
    assert.match(result.stdout, /report\.ts[\s\S]*'mongodb'/)
    assert.match(result.stdout, /5 problems/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rules can be adapted or disabled deliberately', { timeout: 30000 }, () => {
  const root = app({
    'eslint.config.mjs': "import golem from 'golem-kit/eslint'\nexport default golem({ drivers: false })\n",
    'src/app.tsx': "import pg from 'pg'\nexport default function App() { return <main /> }\n",
    'src/legacy.ts': "// eslint-disable-next-line no-restricted-imports -- one-off migration reads backend state\nimport { state } from './server/state.ts'\n",
  })
  try {
    const result = lint(root)
    assert.equal(result.status, 0, result.stdout + result.stderr)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
