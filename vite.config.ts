import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineConfig, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'

const projectRoot = import.meta.dirname

export type UiSource = {
  root: string
  revision: string
}

function gitRevision(root: string): string {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unavailable'
  }
}

export function resolveUiSource(): UiSource | undefined {
  const configured = process.env.GOLEM_UI_SOURCE
  if (!configured) return undefined

  const root = resolve(configured)
  if (!existsSync(resolve(root, 'package.json'))) {
    throw new Error(`GOLEM_UI_SOURCE must point to a golem-ui checkout containing package.json: ${root}`)
  }
  if (!existsSync(resolve(root, 'src/index.ts')) || !existsSync(resolve(root, 'src/styles.css'))) {
    throw new Error(`GOLEM_UI_SOURCE is missing golem-ui src/index.ts or src/styles.css: ${root}`)
  }
  return { root, revision: gitRevision(root) }
}

export default defineConfig(async (): Promise<UserConfig> => {
  const ui = resolveUiSource()
  const plugins: NonNullable<UserConfig['plugins']> = [react()]
  if (ui) {
    const styles = resolve(ui.root, 'src/styles.css')
    plugins.push({
      name: 'golem-ui-source-path',
      enforce: 'pre',
      transform(code: string, id: string) {
        const sourcePath = JSON.stringify(ui.root.replaceAll('\\', '/'))
        return id.split('?')[0] === styles
          ? { code: `@source ${sourcePath};\n${code}`, map: null }
          : undefined
      },
    })
    const tailwindPlugin = resolve(ui.root, 'node_modules/@tailwindcss/vite/dist/index.mjs')
    if (!existsSync(tailwindPlugin)) {
      throw new Error(`GOLEM_UI_SOURCE needs @tailwindcss/vite installed; run pnpm install in ${ui.root}`)
    }
    const { default: tailwindcss } = await import(pathToFileURL(tailwindPlugin).href)
    plugins.push(tailwindcss())
  }
  return {
    plugins,
    resolve: {
      alias: ui ? [
        { find: /^golem-ui$/, replacement: resolve(ui.root, 'src/index.ts') },
        { find: /^golem-ui\/styles\.css$/, replacement: resolve(ui.root, 'src/styles.css') },
      ] : undefined,
      dedupe: ['react', 'react-dom'],
    },
  }
})
