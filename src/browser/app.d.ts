declare module '@golem/app' {
  import type { ComponentType } from 'react'
  /** `screen` is the id of the chosen `screens` item, undefined for the app's first screen. */
  const App: ComponentType<{ screen?: string }>
  export default App
  /** Optional: one bottom-menu item per screen the app has beyond its first. */
  export const screens: { id: string; label: string; icon?: string }[] | undefined
}
declare module '@golem/config' {
  const config: { title: string; brain?: boolean }
  export default config
}
