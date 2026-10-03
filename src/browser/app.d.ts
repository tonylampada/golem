declare module '@golem/app' {
  import type { ComponentType } from 'react'
  /** `screen` is the id of the chosen `screens` item, undefined for the app's first screen. */
  const App: ComponentType<{ screen?: string }>
  export default App
  /** Optional: one bottom-menu item per screen the app has beyond its first; `roles` keeps one to those account roles. */
  export const screens: { id: string; label: string; icon?: string; roles?: string[] }[] | undefined
}
declare module '@golem/config' {
  const config: { title: string; brain?: boolean | { roles: string[] } }
  export default config
}
