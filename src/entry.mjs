import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const frameworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = process.env.GOLEM_SOURCE && resolve(process.env.GOLEM_SOURCE)
const cli = source ? resolve(source, 'src/cli.ts') : resolve(frameworkRoot, 'src/cli.ts')
if (!existsSync(cli)) throw new Error(`GOLEM_SOURCE must point to a Golem checkout containing src/cli.ts: ${source}`)

const installed = !source && frameworkRoot.includes('/node_modules/')
const command = installed ? resolve(process.cwd(), 'node_modules/.bin/golem-kit') : process.execPath
const args = installed ? process.argv.slice(2) : [cli, ...process.argv.slice(2)]
const env = installed ? { ...process.env, PATH: `${resolve(process.cwd(), 'node_modules/.bin')}:${process.env.PATH ?? ''}` } : process.env
const child = spawn(command, args, { cwd: process.cwd(), env, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
const result = await new Promise((resolve, reject) => child.once('error', reject).once('exit', (code, signal) => resolve({ code, signal })))
if (result.signal) process.kill(process.pid, result.signal)
process.exitCode = result.code ?? 1
