import { cpSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

const framework = resolve(import.meta.dirname, '../..')

/** Copies the neutral notes app into `root`, resolving golem-kit to this checkout as an install would. */
export function fixtureApp(root) {
  cpSync(join(framework, 'test/fixtures/notes-app'), root, { recursive: true })
  mkdirSync(join(root, 'node_modules'))
  for (const entry of readdirSync(join(framework, 'node_modules'))) symlinkSync(join(framework, 'node_modules', entry), join(root, 'node_modules', entry))
  symlinkSync(framework, join(root, 'node_modules/golem-kit'))
  return root
}
