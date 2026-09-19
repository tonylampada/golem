import { createRoot } from 'react-dom/client'
import 'golem-ui/styles.css'
import './styles.css'
import { App } from './app'

document.documentElement.style.height = '100%'
document.body.style.height = '100%'
document.body.style.margin = '0'
document.getElementById('root')!.style.height = '100%'
createRoot(document.getElementById('root')!).render(<App />)
