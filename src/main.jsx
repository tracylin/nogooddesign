import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Registered after load so it never competes with the first paint. Without it a
// reload with no signal gives a blank screen, which at a market is the moment
// you can least afford it.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* offline support is a bonus, not a requirement */ });
  });
}
