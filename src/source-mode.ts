import { resolve } from 'node:path'

/**
 * Source mode has to cover the app's own imports, not just the shell's: the app's node_modules
 * still holds the published golem-kit and golem-ui. One table of module specifier to file,
 * shared by the browser bundle, the app server bundle and the app typecheck. A trailing `/*`
 * is a prefix mapping, spelled the way tsconfig `paths` spells it.
 */
export function sourceModules(): Record<string, string> {
  const modules: Record<string, string> = {}
  const kit = process.env.GOLEM_SOURCE && resolve(process.env.GOLEM_SOURCE)
  // golem-kit's own exports map, answered from the checkout instead of node_modules.
  if (kit) Object.assign(modules, {
    'golem-kit/client': resolve(kit, 'src/client.ts'),
    'golem-kit/server': resolve(kit, 'src/backend/index.ts'),
    'golem-kit/operations': resolve(kit, 'src/operations.ts'),
    'golem-kit/*': resolve(kit, '*'),
  })
  // golem-ui publishes only dist/, so source mode answers from src/ and no `pnpm build` is needed.
  const ui = process.env.GOLEM_UI_SOURCE && resolve(process.env.GOLEM_UI_SOURCE)
  if (ui) Object.assign(modules, {
    'golem-ui': resolve(ui, 'src/index.ts'),
    'golem-ui/styles.css': resolve(ui, 'src/styles.css'),
  })
  return modules
}

/** The same table as tsconfig `paths`, for a `tsc` run over the app's own files. */
export function sourcePaths(): Record<string, string[]> {
  return Object.fromEntries(Object.entries(sourceModules()).map(([specifier, file]) => [specifier, [file]]))
}

/** The same table as Vite `resolve.alias` entries; exact specifiers sort before `/*` prefixes. */
export function sourceAliases(): { find: RegExp; replacement: string }[] {
  return Object.entries(sourceModules())
    .sort(([a], [b]) => Number(a.endsWith('/*')) - Number(b.endsWith('/*')))
    .map(([specifier, file]) => specifier.endsWith('/*')
      ? { find: new RegExp(`^${escape(specifier.slice(0, -1))}(.+)$`), replacement: file.replace(/\*$/, '$1') }
      : { find: new RegExp(`^${escape(specifier)}$`), replacement: file })
}

/** The file a bare specifier resolves to in source mode, or undefined when it is not ours to answer. */
export function resolveSourceModule(specifier: string): string | undefined {
  const modules = sourceModules()
  if (modules[specifier]) return modules[specifier]
  for (const [pattern, file] of Object.entries(modules)) {
    if (pattern.endsWith('/*') && specifier.startsWith(pattern.slice(0, -1))) {
      return file.replace(/\*$/, specifier.slice(pattern.length - 1))
    }
  }
  return undefined
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
