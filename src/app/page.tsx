'use client'

import { useEffect, useRef, useState } from 'react'

export default function Home() {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const handleLoad = () => setLoaded(true)
    const iframe = iframeRef.current
    if (iframe) {
      iframe.addEventListener('load', handleLoad)
      return () => iframe.removeEventListener('load', handleLoad)
    }
  }, [])

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      minHeight: '100vh',
      backgroundColor: '#0f1117',
    }}>
      <main style={{ flex: 1 }}>
        {!loaded && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            color: '#8a8fa0',
            fontSize: '14px',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          }}>
            Loading Engineer Mode…
          </div>
        )}
        <iframe
          ref={iframeRef}
          src="/app/index.html"
          title="VoiceIsolate Pro — Engineer Mode"
          style={{
            width: '100%',
            height: '100vh',
            border: 'none',
            display: loaded ? 'block' : 'none',
          }}
        />
      </main>
    </div>
  )
}