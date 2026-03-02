import { useState } from 'react';

function App() {
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [activeTab, setActiveTab] = useState('noise');

  return (
    <div className="min-h-screen bg-bg text-text">
      {/* Header */}
      <header className="border-b border-red-900/20 bg-surface px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="text-3xl">🎙️</div>
            <div>
              <h1 className="text-2xl font-bold text-accent">VoiceIsolate Pro</h1>
              <p className="text-sm text-dim">v14.0 - 26-Stage Penta-Pass DSP</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button className="px-4 py-2 rounded bg-surface2 hover:bg-surface2/80 text-text transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              Export
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto p-6">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-6">
          {/* Left Column - Audio Processor */}
          <div className="space-y-6">
            {/* Upload Zone */}
            <div
              className="bg-surface rounded-lg border-2 border-dashed border-accent/30 p-12 text-center hover:border-accent/50 transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              role="button"
              tabIndex={0}
              aria-label="Upload audio or video file"
            >
              <div className="text-6xl mb-4" aria-hidden="true">📁</div>
              <h3 className="text-xl font-semibold mb-2">Drop audio or video file</h3>
              <p className="text-dim">MP3, WAV, M4A, FLAC, MP4, MOV, WEBM supported</p>
            </div>

            {/* Waveform Display */}
            <div className="bg-surface rounded-lg p-6">
              <h3 className="text-lg font-semibold mb-4 text-accent">Waveform</h3>
              <div className="h-32 bg-surface2 rounded flex items-center justify-center">
                <p className="text-dim">No audio loaded</p>
              </div>
            </div>

            {/* Playback Controls */}
            <div className="bg-surface rounded-lg p-6">
              <div className="flex items-center gap-4">
                <button
                  className="w-12 h-12 rounded-full bg-accent hover:bg-accent2 flex items-center justify-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                  aria-label="Play audio"
                >
                  <span aria-hidden="true">▶️</span>
                </button>
                <div className="flex-1 h-2 bg-surface2 rounded-full">
                  <div className="h-full bg-accent rounded-full" style={{width: '0%'}}></div>
                </div>
                <span className="text-dim text-sm">0:00 / 0:00</span>
              </div>
            </div>
          </div>

          {/* Right Column - Controls */}
          <div className="space-y-6">
            {/* Tabs */}
            <div className="bg-surface rounded-lg p-2">
              <div className="flex gap-1" role="tablist" aria-label="Processing Categories">
                {['noise', 'enhance', 'room', 'advanced'].map(tab => (
                  <button
                    key={tab}
                    role="tab"
                    aria-selected={activeTab === tab}
                    aria-controls={`panel-${tab}`}
                    id={`tab-${tab}`}
                    onClick={() => setActiveTab(tab)}
                    className={`flex-1 py-2 px-3 rounded text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                      activeTab === tab 
                        ? 'bg-accent text-white' 
                        : 'bg-surface2 text-dim hover:text-text'
                    }`}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Sliders Panel */}
            <div
              className="bg-surface rounded-lg p-6 space-y-4 max-h-[600px] overflow-y-auto"
              role="tabpanel"
              id={`panel-${activeTab}`}
              aria-labelledby={`tab-${activeTab}`}
            >
              <h3 className="text-lg font-semibold text-accent mb-4">Processing Controls</h3>
              
              {/* Sample Sliders */}
              {[
                { id: 'noise-reduction', label: 'Noise Reduction', value: 75 },
                { id: 'voice-presence', label: 'Voice Presence', value: 80 },
                { id: 'clarity', label: 'Clarity', value: 65 },
                { id: 'de-reverb', label: 'De-reverb', value: 50 },
                { id: 'harmonic-boost', label: 'Harmonic Boost', value: 40 },
              ].map((slider) => (
                <div key={slider.id} className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <label htmlFor={slider.id} className="text-text">{slider.label}</label>
                    <span className="text-accent font-medium" aria-hidden="true">{slider.value}</span>
                  </div>
                  <input 
                    id={slider.id}
                    type="range" 
                    min="0" 
                    max="100" 
                    defaultValue={slider.value}
                    aria-label={`${slider.label} value`}
                    className="w-full h-2 bg-surface2 rounded-lg appearance-none cursor-pointer accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  />
                </div>
              ))}

              {/* Presets */}
              <div className="pt-4 border-t border-red-900/20">
                <h4 className="text-sm font-semibold mb-3">Presets</h4>
                <div className="grid grid-cols-2 gap-2">
                  {['Podcast Pro', 'Crystal Voice', 'Interview', 'Film Dialogue'].map(preset => (
                    <button
                      key={preset}
                      className="py-2 px-3 bg-surface2 hover:bg-accent/20 rounded text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Processing Status */}
        {processing && (
          <div className="fixed bottom-6 right-6 bg-surface border border-accent/30 rounded-lg p-4 w-80">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">Processing...</span>
              <span className="text-accent text-sm">{progress}%</span>
            </div>
            <div className="h-2 bg-surface2 rounded-full overflow-hidden">
              <div className="h-full bg-accent transition-all" style={{width: `${progress}%`}}></div>
            </div>
            <p className="text-xs text-dim mt-2">Stage {Math.floor(progress/4)}/26</p>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
