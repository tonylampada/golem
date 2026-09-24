import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const frameworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = process.env.GOLEM_SOURCE && resolve(process.env.GOLEM_SOURCE)
const cli = source ? resolve(source, 'src/cli.ts') : resolve(frameworkRoot, 'src/cli.ts')
if (!existsSync(cli)) throw new Error(`GOLEM_SOURCE must point to a Golem checkout containing src/cli.ts: ${source}`)

// Node does not strip types from files under node_modules, so the installed CLI needs tsx. Resolve
// it from this file — golem-kit's own dependency tree — because pnpm does not link a transitive
// dependency's bin into the app's node_modules/.bin, so the app's PATH may not have tsx at all.
const installed = !source && frameworkRoot.includes('/node_modules/')
const args = installed
  ? [createRequire(import.meta.url).resolve('tsx/cli'), cli, ...process.argv.slice(2)]
  : [cli, ...process.argv.slice(2)]
const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
const result = await new Promise((resolve, reject) => child.once('error', reject).once('exit', (code, signal) => resolve({ code, signal })))
if (result.signal) process.kill(process.pid, result.signal)
process.exitCode = result.code ?? 1
