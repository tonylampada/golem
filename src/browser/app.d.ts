declare module '@golem/app' {
  import type { ComponentType } from 'react'
  const App: ComponentType
  export default App
}
declare module '@golem/config' {
  const config: { title: string }
  export default config
}
