/**
 * VoiceIsolate Pro — app.js  v24.0.0
 * ====================================
 * Exports:  class VoiceIsolatePro  (also assigned to window.VoiceIsolatePro)
 *
 * vip-boot.js contract:
 *   - typeof VoiceIsolatePro !== 'undefined'   after this module evaluates
 *   - new VoiceIsolatePro()                    must not throw
 *   - instance.init()                          completes async bootstrap
 *   - window._vipApp                           set to the live instance
 *
 * Single-Pass Spectral Contract:
 *   ONE forward STFT  → in-place spectral ops → ONE iSTFT
 *   All spectral work delegated to pipeline-orchestrator.js.
 *   app.js provides DSP helpers used by the pipeline.
 *
 * 100 % local — no cloud APIs, no external fetch except /app/models/*.onnx.
 */

import { SLIDER_REGISTRY, STAGES } from './slider-map.js';
import { ModelStatusUI } from './model-status-ui.js';

// Model keys served by /app/models-manifest.json (ModelCDNLoader.getManifest()) —
// drives the "Model Cache & Providers" pills + Local Model Health panel.
const MODEL_STATUS_KEYS = ['demucs', 'bsrnn', 'rnnoise', 'silero_vad'];

// ---------------------------------------------------------------------------
// SAB ring-buffer constants (must match dsp-processor.js exactly)
// ---------------------------------------------------------------------------
const FFT_SIZE = 4096;
const HOP_SIZE = 1024;
const HALF_BINS = FFT_SIZE / 2 + 1;
const SAB_HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * 5; // FLAG_SLOTS = 5

// ---------------------------------------------------------------------------
// 52-Slider definition (inline — tests parse this source directly)
// ---------------------------------------------------------------------------
const SLIDERS = {
  gate: [
    { id:'gateThresh', label:'Threshold', min:-80, max:-5, val:-42, step:1, unit:' dB', rt:true, desc:'Audio quieter than this level is treated as silence and turned down.', example:'Raise toward -30 dB to mute the room tone between sentences in a voice memo; lower toward -60 dB so soft speech is never cut off.' },
    { id:'gateRange', label:'Range', min:-80, max:-5, val:-60, step:1, unit:' dB', rt:true, desc:'How far the gated (silent) sections are turned down.', example:'-60 dB fully silences gaps; set -12 dB to just soften background hiss instead of killing it, keeping a natural ambience.' },
    { id:'gateAttack', label:'Attack', min:0, max:500, val:5, step:1, unit:' ms', rt:true, desc:'How fast the gate opens when speech starts.', example:'Keep at ~5 ms so the start of each word ("Hello") is not clipped; longer values soften hard consonants.' },
    { id:'gateRelease', label:'Release', min:50, max:2000, val:200, step:10, unit:' ms', rt:true, desc:'How fast the gate closes after sound stops.', example:'~200 ms feels natural for speech; raise to 800 ms so the tail of a sung note or reverb is not chopped off abruptly.' },
    { id:'gateHold', label:'Hold', min:0, max:500, val:50, step:1, unit:' ms', rt:true, desc:'Minimum time the gate stays open after a sound.', example:'Set ~80 ms to stop the gate "chattering" open and shut during a stuttered or breathy phrase.' },
    { id:'gateLookahead', label:'Lookahead', min:0, max:50, val:5, step:1, unit:' ms', rt:false, desc:'Lets the gate peek ahead so it opens just before a sound arrives.', example:'5–10 ms preserves the sharp attack of a clapper or plosive that a zero-lookahead gate would shave off.' },
  ],
  nr: [
    { id:'nrAmount', label:'NR Amount', min:0, max:100, val:78, step:1, unit:'%', rt:false, desc:'Overall strength of the spectral noise removal.', example:'~70% cleans steady air-conditioner hiss from an interview; push past 90% only for heavy noise, as it can make the voice sound underwater.' },
    { id:'nrSensitivity', label:'Sensitivity', min:0, max:100, val:60, step:1, unit:'%', rt:false, desc:'How aggressively the noise floor is detected and learned.', example:'Raise to ~80% when noise is loud and constant (traffic); lower to ~40% to avoid mistaking quiet speech for noise.' },
    { id:'nrSpectralSub', label:'Spectral Sub', min:0, max:100, val:50, step:1, unit:'%', rt:false, desc:'Extra subtraction of the learned noise spectrum.', example:'Bump to ~70% to scrub tonal hum/whine; high values can add a "musical noise" warble, so back off if you hear bubbling.' },
    { id:'nrFloor', label:'NR Floor', min:-96, max:-30, val:-72, step:1, unit:' dB', rt:false, desc:'How deep the quietest residual noise is allowed to drop.', example:'-72 dB is transparent; set -40 dB to leave a faint natural noise bed so dialogue does not sound unnaturally dead.' },
    { id:'nrSmoothing', label:'Smoothing', min:0, max:100, val:70, step:1, unit:'%', rt:false, desc:'Averages noise estimates over time to reduce artifacts.', example:'~70% smooths out flutter on steady noise; lower to ~30% for fast-changing scenes so reduction can react quickly.' },
  ],
  eq: [
    { id:'eqSub', label:'Sub', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Lowest rumble band (20–60 Hz).', example:'Cut -6 dB to remove desk thumps and AC rumble from a podcast; rarely boosted for voice.' },
    { id:'eqBass', label:'Bass', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Bass weight band (60–200 Hz).', example:'Boost +2 dB for a fuller, radio-style male voice; cut -4 dB if speech sounds boomy or muddy.' },
    { id:'eqWarmth', label:'Warmth', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Lower-midrange warmth (200–500 Hz).', example:'A small +1.5 dB adds chest/warmth; cut -3 dB to clear "boxy" muddiness on a close-mic recording.' },
    { id:'eqBody', label:'Body', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Core body of the voice (500 Hz–1 kHz).', example:'Boost +1 dB for a thicker voice; cut to reduce a hollow, telephone-like tone.' },
    { id:'eqLowMid', label:'Low Mid', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Low-mid definition (1–2 kHz).', example:'Nudge +1 dB to help vowels cut through music; cut if the voice sounds nasal or honky.' },
    { id:'eqMid', label:'Mid', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Intelligibility band (2–4 kHz).', example:'Boost +2 dB so dialogue is easier to understand over background noise; too much sounds harsh.' },
    { id:'eqPresence', label:'Presence', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Presence and forwardness (4–6 kHz).', example:'+1.5 dB makes a voice sound closer and more "in the room"; cut to tame an aggressive announcer.' },
    { id:'eqClarity', label:'Clarity', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Detail and consonants (6–10 kHz).', example:'Boost +1 dB for crisp "s" and "t" sounds; cut if sibilance is harsh (pair with the de-esser).' },
    { id:'eqAir', label:'Air', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Open "air" band (10–16 kHz).', example:'+1 dB adds an expensive, airy sheen to vocals; cut on noisy phone recordings to hide hiss.' },
    { id:'eqBrill', label:'Brilliance', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true, desc:'Top-end sparkle (16–20 kHz).', example:'A gentle +0.5 dB adds shimmer to music vocals; usually left flat or cut for spoken word.' },
  ],
  dyn: [
    { id:'compThresh', label:'Threshold', min:-60, max:0, val:-24, step:1, unit:' dB', rt:true, desc:'Level where the compressor starts evening out volume.', example:'Set ~-24 dB so loud and soft words sit closer together; lower it to compress more of the performance.' },
    { id:'compRatio', label:'Ratio', min:1, max:20, val:4, step:0.5, unit:':1', rt:true, desc:'How hard volume above the threshold is reduced.', example:'4:1 is a natural podcast setting; 10:1+ acts almost like a limiter for very uneven phone audio.' },
    { id:'compAttack', label:'Attack', min:1, max:200, val:10, step:1, unit:' ms', rt:true, desc:'How quickly compression clamps down on a loud peak.', example:'~10 ms keeps speech punchy; very fast (1 ms) squashes transients for a denser, controlled sound.' },
    { id:'compRelease', label:'Release', min:10, max:1000, val:150, step:10, unit:' ms', rt:true, desc:'How quickly compression lets go after a peak.', example:'~150 ms breathes naturally with speech; too short can cause an audible pumping on sustained notes.' },
    { id:'compKnee', label:'Knee', min:0, max:30, val:6, step:1, unit:' dB', rt:true, desc:'How gradually compression eases in around the threshold.', example:'A soft 6 dB knee is gentle and transparent for voice; 0 dB (hard knee) is more obvious and aggressive.' },
    { id:'compMakeup', label:'Makeup', min:0, max:30, val:0, step:0.5, unit:' dB', rt:true, desc:'Volume added back after compression lowers the level.', example:'Add +3 dB so the compressed voice is as loud as before but more consistent and present.' },
    { id:'limThresh', label:'Lim Thresh', min:-12, max:0, val:-1, step:0.5, unit:' dB', rt:true, desc:'Hard ceiling that output peaks can never exceed.', example:'-1 dB prevents clipping/distortion on export; lower to -3 dB for extra safety headroom before encoding.' },
    { id:'limRelease', label:'Lim Release', min:10, max:500, val:50, step:5, unit:' ms', rt:true, desc:'How fast the limiter recovers after catching a peak.', example:'~50 ms is clean for speech; longer values sound smoother on music but can dull transients.' },
  ],
  spec: [
    { id:'hpFreq', label:'HP Freq', min:20, max:2000, val:80, step:1, unit:' Hz', rt:true, desc:'Removes everything below this frequency (a high-pass filter).', example:'80 Hz strips rumble from speech; raise to 300 Hz for a thin telephone/walkie-talkie effect.' },
    { id:'hpQ', label:'HP Q', min:0.1, max:10, val:0.7, step:0.1, unit:'', rt:true, desc:'Sharpness of the high-pass cutoff.', example:'0.7 is a smooth, natural roll-off; higher Q makes the cut steeper with a slight bump at the corner.' },
    { id:'lpFreq', label:'LP Freq', min:4000, max:20000, val:18000, step:100, unit:' Hz', rt:true, desc:'Removes everything above this frequency (a low-pass filter).', example:'18 kHz keeps it natural; drop to 4 kHz to hide hiss or fake an old-radio sound.' },
    { id:'lpQ', label:'LP Q', min:0.1, max:10, val:0.7, step:0.1, unit:'', rt:true, desc:'Sharpness of the low-pass cutoff.', example:'0.7 is gentle; higher Q steepens the cut and adds a resonant edge near the corner frequency.' },
    { id:'deEssFreq', label:'De-ess Freq', min:2000, max:12000, val:6000, step:100, unit:' Hz', rt:true, desc:'Center of the harsh "ess/sh" sibilance the de-esser targets.', example:'~6 kHz for most voices; sweep to 7–8 kHz for a bright/sharp speaker whose "s" sounds pierce.' },
    { id:'deEssAmt', label:'De-ess Amt', min:0, max:30, val:0, step:1, unit:' dB', rt:true, desc:'How much the harsh "s" and "sh" sounds are tamed.', example:'Set 6 dB to soften sharp sibilance on a podcast; 0 leaves it untouched.' },
    { id:'specTilt', label:'Spec Tilt', min:-6, max:6, val:0, step:0.5, unit:' dB', rt:true, desc:'Tilts overall tone darker (−) or brighter (+) in one move.', example:'+2 dB brightens a dull recording; -2 dB warms a harsh one without touching individual EQ bands.' },
    { id:'formantShift', label:'Formant Shift', min:-6, max:6, val:0, step:0.5, unit:' st', rt:false, desc:'Shifts vocal character without changing pitch (semitones).', example:'-2 st makes a voice sound larger/deeper; +2 st sounds smaller/younger — useful for light disguise or tone.' },
  ],
  adv: [
    { id:'derevAmt', label:'Dereverb', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Reduces echo/room reverb so a voice sounds drier and closer.', example:'Set ~50% to pull a voice out of an echoey hall recording; too high can sound thin and gated.' },
    { id:'derevDecay', label:'Rev Decay', min:0, max:100, val:50, step:1, unit:'%', rt:false, desc:'Tells dereverb how long the room\'s echo tail lasts.', example:'Raise toward 80% for a big, slow church/stairwell echo; lower for a small, fast bathroom slap.' },
    { id:'harmRecov', label:'Harm Recovery', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Rebuilds harmonics lost to heavy noise reduction or low bitrate.', example:'Add ~40% to restore richness to a muffled phone-call or over-denoised voice.' },
    { id:'harmOrder', label:'Harm Order', min:1, max:10, val:3, step:1, unit:'', rt:false, desc:'How many harmonic overtones are reconstructed.', example:'3 is natural for speech; higher orders add more brightness/edge to the recovered tone.' },
    { id:'stereoWidth', label:'Stereo Width', min:0, max:200, val:100, step:1, unit:'%', rt:true, desc:'Widens or narrows the stereo image (mid/side).', example:'120% makes music vocals feel wider; 0% collapses to mono for a focused, centered voice.' },
    { id:'phaseCorr', label:'Phase Corr', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Fixes out-of-phase stereo so it stays solid in mono.', example:'Raise to ~40% when a stereo clip goes hollow/thin on a phone speaker that sums to mono.' },
  ],
  sep: [
    { id:'voiceIso', label:'Voice Iso', min:0, max:100, val:80, step:1, unit:'%', rt:false, desc:'Emphasises the human voice over everything else.', example:'~80% lifts a speaker out of background music; near 100% is forensic-grade but can sound processed.' },
    { id:'bgSuppress', label:'BG Suppress', min:0, max:100, val:50, step:1, unit:'%', rt:false, desc:'Lowers sound that sits outside the voice focus band.', example:'Set ~60% to push down street noise and crowd chatter while keeping the dialogue forward.' },
    { id:'voiceFocusLo', label:'Focus Lo', min:80, max:500, val:120, step:10, unit:' Hz', rt:false, desc:'Bottom edge of the band kept as "voice".', example:'~120 Hz suits most voices; raise to 200 Hz to ignore deep rumble, lower for very deep male voices.' },
    { id:'voiceFocusHi', label:'Focus Hi', min:1000, max:8000, val:3400, step:100, unit:' Hz', rt:false, desc:'Top edge of the band kept as "voice".', example:'3400 Hz mimics telephone clarity; raise to 5000 Hz to keep crisp consonants and a more natural top.' },
    { id:'crosstalkCancel', label:'Crosstalk', min:0, max:100, val:0, step:1, unit:'%', rt:false, desc:'Removes bleed of one stereo channel into the other.', example:'Use ~40% on a two-mic interview where each voice leaks into the opposite channel.' },
  ],
  out: [
    { id:'outGain', label:'Output Gain', min:-24, max:24, val:0, step:0.5, unit:' dB', rt:true, desc:'Final overall volume trim on the processed output.', example:'Add +3 dB if the cleaned voice is too quiet; the limiter still prevents clipping above its ceiling.' },
    { id:'dryWet', label:'Dry/Wet', min:0, max:100, val:100, step:1, unit:'%', rt:true, desc:'Blends the original (dry) with the processed (wet) signal.', example:'100% is fully processed; drop to 70% to keep a touch of the natural original and soften aggressive cleanup.' },
    { id:'ditherAmt', label:'Dither', min:0, max:10, val:1, step:0.1, unit:' bits', rt:false, desc:'Adds tiny noise that smooths quiet detail when exporting.', example:'Leave at ~1 for clean fades to silence; set 0 if you will keep full 32-bit float quality.' },
    { id:'outWidth', label:'Out Width', min:0, max:200, val:100, step:1, unit:'%', rt:true, desc:'Final stereo width applied at the very end of the chain.', example:'100% leaves width unchanged; 0% guarantees a centered mono output for phone playback.' },
  ],
};
const SLIDER_MAP = Object.fromEntries(
  Object.values(SLIDERS).flat().map(s => [s.id, { ...s, default: s.val }])
);

// Flat lookup (frozen, used by clampToSlider and applyPreset)
const SLIDER_BY_ID = Object.freeze(
  Object.values(SLIDERS).flat().reduce((acc, s) => { acc[s.id] = s; return acc; }, {})
);

// ---------------------------------------------------------------------------
// 8 Named presets (each covers all 52 slider IDs)
// ---------------------------------------------------------------------------
const PRESETS = {
  'Voice Clarity': {
    description: 'Enhance voice intelligibility with moderate noise reduction',
    gateThresh: -42, gateRange: -60, gateAttack: 5, gateRelease: 200, gateHold: 50, gateLookahead: 5,
    nrAmount: 70, nrSensitivity: 60, nrSpectralSub: 50, nrFloor: -72, nrSmoothing: 70,
    eqSub: 0, eqBass: 0, eqWarmth: 1, eqBody: 1, eqLowMid: 0, eqMid: 0.5, eqPresence: 1, eqClarity: 0, eqAir: 0, eqBrill: 0,
    compThresh: -24, compRatio: 4, compAttack: 10, compRelease: 150, compKnee: 6, compMakeup: 0, limThresh: -1, limRelease: 50,
    hpFreq: 80, hpQ: 0.7, lpFreq: 18000, lpQ: 0.7, deEssFreq: 6000, deEssAmt: 0, specTilt: 0, formantShift: 0,
    derevAmt: 0, derevDecay: 50, harmRecov: 0, harmOrder: 3, stereoWidth: 100, phaseCorr: 0,
    voiceIso: 80, bgSuppress: 50, voiceFocusLo: 120, voiceFocusHi: 3400, crosstalkCancel: 0,
    outGain: 2, dryWet: 100, ditherAmt: 1, outWidth: 100,
  },
  'Podcast Clean': {
    description: 'Studio-clean podcast voice with de-essing and compression',
    gateThresh: -50, gateRange: -60, gateAttack: 5, gateRelease: 200, gateHold: 50, gateLookahead: 5,
    nrAmount: 85, nrSensitivity: 65, nrSpectralSub: 60, nrFloor: -72, nrSmoothing: 75,
    eqSub: -3, eqBass: 0, eqWarmth: 1, eqBody: 1, eqLowMid: 0, eqMid: 0.5, eqPresence: 1.5, eqClarity: 0.5, eqAir: 0, eqBrill: 0,
    compThresh: -20, compRatio: 3, compAttack: 10, compRelease: 150, compKnee: 6, compMakeup: 2, limThresh: -1, limRelease: 50,
    hpFreq: 100, hpQ: 0.7, lpFreq: 16000, lpQ: 0.7, deEssFreq: 7000, deEssAmt: 6, specTilt: 0, formantShift: 0,
    derevAmt: 10, derevDecay: 50, harmRecov: 0, harmOrder: 3, stereoWidth: 100, phaseCorr: 0,
    voiceIso: 75, bgSuppress: 60, voiceFocusLo: 120, voiceFocusHi: 3400, crosstalkCancel: 0,
    outGain: 0, dryWet: 100, ditherAmt: 1, outWidth: 100,
  },
  'Forensic Extract': {
    description: 'Maximum extraction for forensic audio analysis',
    gateThresh: -60, gateRange: -80, gateAttack: 2, gateRelease: 100, gateHold: 20, gateLookahead: 10,
    nrAmount: 95, nrSensitivity: 80, nrSpectralSub: 85, nrFloor: -80, nrSmoothing: 85,
    eqSub: -6, eqBass: -3, eqWarmth: 0, eqBody: 1, eqLowMid: 1, eqMid: 2, eqPresence: 2, eqClarity: 1, eqAir: 0, eqBrill: -2,
    compThresh: -30, compRatio: 8, compAttack: 5, compRelease: 100, compKnee: 3, compMakeup: 6, limThresh: -1, limRelease: 30,
    hpFreq: 150, hpQ: 0.9, lpFreq: 12000, lpQ: 0.7, deEssFreq: 8000, deEssAmt: 12, specTilt: 1, formantShift: 0,
    derevAmt: 60, derevDecay: 60, harmRecov: 20, harmOrder: 3, stereoWidth: 100, phaseCorr: 30,
    voiceIso: 98, bgSuppress: 90, voiceFocusLo: 100, voiceFocusHi: 4000, crosstalkCancel: 40,
    outGain: 8, dryWet: 100, ditherAmt: 1, outWidth: 100,
  },
  'Music Vocal': {
    description: 'Preserve natural vocal character for music production',
    gateThresh: -45, gateRange: -55, gateAttack: 8, gateRelease: 300, gateHold: 60, gateLookahead: 5,
    nrAmount: 40, nrSensitivity: 40, nrSpectralSub: 30, nrFloor: -60, nrSmoothing: 50,
    eqSub: 0, eqBass: 1, eqWarmth: 2, eqBody: 1, eqLowMid: 0, eqMid: 0, eqPresence: 1, eqClarity: 1, eqAir: 1, eqBrill: 0.5,
    compThresh: -18, compRatio: 2.5, compAttack: 15, compRelease: 200, compKnee: 8, compMakeup: 2, limThresh: -1, limRelease: 60,
    hpFreq: 60, hpQ: 0.5, lpFreq: 20000, lpQ: 0.7, deEssFreq: 6500, deEssAmt: 4, specTilt: 0, formantShift: 0,
    derevAmt: 5, derevDecay: 50, harmRecov: 50, harmOrder: 3, stereoWidth: 110, phaseCorr: 0,
    voiceIso: 60, bgSuppress: 30, voiceFocusLo: 100, voiceFocusHi: 5000, crosstalkCancel: 0,
    outGain: 0, dryWet: 100, ditherAmt: 1, outWidth: 110,
  },
  'Whisper Boost': {
    description: 'Amplify and clarify soft whispering voices',
    gateThresh: -65, gateRange: -70, gateAttack: 3, gateRelease: 150, gateHold: 30, gateLookahead: 8,
    nrAmount: 60, nrSensitivity: 50, nrSpectralSub: 45, nrFloor: -75, nrSmoothing: 65,
    eqSub: -6, eqBass: -3, eqWarmth: 0, eqBody: 2, eqLowMid: 2, eqMid: 3, eqPresence: 3, eqClarity: 2, eqAir: 1, eqBrill: 0,
    compThresh: -36, compRatio: 6, compAttack: 5, compRelease: 100, compKnee: 4, compMakeup: 8, limThresh: -1, limRelease: 40,
    hpFreq: 120, hpQ: 0.7, lpFreq: 14000, lpQ: 0.7, deEssFreq: 6000, deEssAmt: 3, specTilt: 1, formantShift: 0,
    derevAmt: 20, derevDecay: 40, harmRecov: 10, harmOrder: 3, stereoWidth: 100, phaseCorr: 10,
    voiceIso: 70, bgSuppress: 65, voiceFocusLo: 150, voiceFocusHi: 4000, crosstalkCancel: 10,
    outGain: 6, dryWet: 100, ditherAmt: 1, outWidth: 100,
  },
  'Phone/Radio': {
    description: 'Simulate telephone or radio band-limited audio',
    gateThresh: -50, gateRange: -60, gateAttack: 5, gateRelease: 200, gateHold: 50, gateLookahead: 5,
    nrAmount: 80, nrSensitivity: 70, nrSpectralSub: 65, nrFloor: -72, nrSmoothing: 75,
    eqSub: -12, eqBass: -8, eqWarmth: -4, eqBody: 0, eqLowMid: 2, eqMid: 1, eqPresence: 0, eqClarity: -4, eqAir: -8, eqBrill: -12,
    compThresh: -20, compRatio: 5, compAttack: 8, compRelease: 120, compKnee: 4, compMakeup: 4, limThresh: -1, limRelease: 40,
    hpFreq: 300, hpQ: 1.2, lpFreq: 4000, lpQ: 1.0, deEssFreq: 3000, deEssAmt: 8, specTilt: -1, formantShift: 0,
    derevAmt: 15, derevDecay: 30, harmRecov: 0, harmOrder: 3, stereoWidth: 0, phaseCorr: 0,
    voiceIso: 85, bgSuppress: 70, voiceFocusLo: 300, voiceFocusHi: 3400, crosstalkCancel: 20,
    outGain: 2, dryWet: 100, ditherAmt: 1, outWidth: 0,
  },
  'Live Performance': {
    description: 'Minimal processing for live stage or broadcast',
    gateThresh: -38, gateRange: -50, gateAttack: 10, gateRelease: 300, gateHold: 80, gateLookahead: 5,
    nrAmount: 30, nrSensitivity: 35, nrSpectralSub: 25, nrFloor: -55, nrSmoothing: 40,
    eqSub: 0, eqBass: 1, eqWarmth: 1, eqBody: 0, eqLowMid: 0, eqMid: 0, eqPresence: 1, eqClarity: 0.5, eqAir: 0, eqBrill: 0,
    compThresh: -24, compRatio: 3, compAttack: 15, compRelease: 200, compKnee: 8, compMakeup: 2, limThresh: -2, limRelease: 60,
    hpFreq: 80, hpQ: 0.7, lpFreq: 18000, lpQ: 0.7, deEssFreq: 6500, deEssAmt: 2, specTilt: 0, formantShift: 0,
    derevAmt: 0, derevDecay: 50, harmRecov: 0, harmOrder: 3, stereoWidth: 120, phaseCorr: 0,
    voiceIso: 50, bgSuppress: 25, voiceFocusLo: 100, voiceFocusHi: 5000, crosstalkCancel: 0,
    outGain: 0, dryWet: 100, ditherAmt: 1, outWidth: 120,
  },
  'Surveillance': {
    description: 'Maximum noise reduction for challenging surveillance audio',
    gateThresh: -70, gateRange: -80, gateAttack: 2, gateRelease: 100, gateHold: 20, gateLookahead: 10,
    nrAmount: 92, nrSensitivity: 85, nrSpectralSub: 80, nrFloor: -80, nrSmoothing: 85,
    eqSub: -6, eqBass: -3, eqWarmth: 0, eqBody: 1, eqLowMid: 2, eqMid: 3, eqPresence: 2, eqClarity: 1, eqAir: 0, eqBrill: -3,
    compThresh: -28, compRatio: 7, compAttack: 5, compRelease: 100, compKnee: 3, compMakeup: 6, limThresh: -1, limRelease: 30,
    hpFreq: 100, hpQ: 0.9, lpFreq: 12000, lpQ: 0.7, deEssFreq: 7000, deEssAmt: 10, specTilt: 1, formantShift: 0,
    derevAmt: 40, derevDecay: 55, harmRecov: 15, harmOrder: 3, stereoWidth: 100, phaseCorr: 20,
    voiceIso: 90, bgSuppress: 85, voiceFocusLo: 100, voiceFocusHi: 4000, crosstalkCancel: 30,
    outGain: 10, dryWet: 100, ditherAmt: 1, outWidth: 100,
  },
};
// Aliases
const PRESET_NAMES = Object.keys(PRESETS);

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function structuredLog(level, msg, data = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  const debugEnabled = (typeof window !== 'undefined') && !!window.VIP_DEBUG;
  if (level === 'error') console.error('[VIP]', msg, data);
  else if (level === 'warn') console.warn('[VIP]', msg, data);
  else if (debugEnabled) console.log('[VIP]', msg, data);
  if (typeof window !== 'undefined') {
    if (!window._vipLogs) window._vipLogs = [];
    if (window._vipLogs.length >= 200) window._vipLogs.shift();
    window._vipLogs.push(entry);
  }
  return entry;
}

function clampToSlider(id, value) {
  const s = SLIDER_BY_ID[id];
  const v = Number(value);
  if (!Number.isFinite(v)) return s ? s.val : 0;
  if (!s) return v;
  if (v < s.min) return s.min;
  if (v > s.max) return s.max;
  return v;
}

function numFromInput(el, fallback = 0) {
  if (!el) return fallback;
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : fallback;
}

function pill(id, state) {
  if (typeof window._setVipEnginePill === 'function') window._setVipEnginePill(id, state);
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// WAV encoder (standalone helper)
// ---------------------------------------------------------------------------
function encodeWavBuffer(audioBuffer) {
  const numCh = audioBuffer.numberOfChannels;
  const numSamples = audioBuffer.length;
  const sr = audioBuffer.sampleRate;
  const bps = 2;
  const buf = new ArrayBuffer(44 + numSamples * numCh * bps);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, buf.byteLength - 8, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, numCh, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * numCh * bps, true); v.setUint16(32, numCh * bps, true);
  v.setUint16(34, 16, true); ws(36, 'data'); v.setUint32(40, numSamples * numCh * bps, true);
  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, audioBuffer.getChannelData(ch)[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
  }
  return buf;
}

function downloadWav(audioBuffer, name) {
  const blob = new Blob([encodeWavBuffer(audioBuffer)], { type: 'audio/wav' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// ---------------------------------------------------------------------------
// VoiceIsolatePro — main class
// ---------------------------------------------------------------------------
class VoiceIsolatePro {
  constructor() {
    // Expose STAGES on instance for pipeline overlay
    this.STAGES = STAGES;

    // Abort flag for runPipeline cancellation
    this.abortFlag = false;

    // Live chain state
    this.liveChainBuilt = false;

    // Audio context / chain
    this.ctx = null;
    this.workletNode = null;
    this.sourceNode = null;

    // ML
    this.mlReady = false;
    this._mlCallId = 0;

    // ONNX sessions
    this.onnxSessions = {};
    this._onnxSession = null;
    this._onnxReady = false;
    this._dspOnlyMode = false;

    // State flags
    this.mode = 'idle';
    this._initCalled = false;
    this._ctxReady = false;
    this._workletReady = false;
    this._workletSliderListenersBound = false;
    this._pendingCtxInit = null;
    this.isPlaying = false;
    this.isProcessing = false;
    this.isVideo = false;

    // Playback state
    this.inputBuffer = null;
    this.outputBuffer = null;
    this.origBuffer = null;
    this.procBuffer = null;
    this.playOffset = 0;
    this.playStartTime = 0;
    this.abMode = 'original';
    this.currentSource = null;

    // Forensic audit log
    this.forensicLog = [];

    // SAB param lane
    this.sharedParams = null;
    this._inputSAB = null;
    this._outputSAB = null;

    // Slider index map (1-indexed: slot 0 = bypass flag)
    this._sliderIndexById = new Map(SLIDER_REGISTRY.map((s, i) => [s.id, i + 1]));

    // Flat params snapshot — mirrors window.VIP_PARAMS, kept in sync by
    // _renderSliders() and applyPreset() so the orchestrator patches work.
    this.params = Object.fromEntries(
      Object.values(SLIDERS).flat().map(s => [s.id, s.val])
    );

    // Model status UI
    this._modelStatusUI = null;

    // DOM cache (populated in cacheDom / init)
    this.dom = {};

    // Pre-populate dom if DOM is already available (e.g. in jsdom test environments)
    if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
      try { this.cacheDom(); } catch (_) {}
    }
  }

  // ── Public init ──────────────────────────────────────────────────────────
  async init() {
    if (this._initCalled) return;
    this._initCalled = true;

    this.cacheDom();
    this._renderSliders();
    this.bindEvents();
    this._updateProcessButtonsState();
    this.initBootSplash();
    this.initModelStatusPanel();

    // Resolve the ML engine pill (CTX/WORKLET/SAB/ML/NET cockpit) based on ONNX Runtime
    // availability — without this, engMlPill stays stuck on "loading" forever since no
    // orchestrator sets window._vipOrch.mlReady or window.VIP_ML_AVAILABLE in this build.
    // We avoid eagerly calling loadModels() here: it would download the 2MB model file on
    // the main thread, which is never used since actual inference runs in MLWorker.js.
    const ort = (typeof window !== 'undefined' && window.ort) || (typeof globalThis !== 'undefined' && globalThis.ort);
    if (ort && ort.InferenceSession) {
      window.VIP_ML_AVAILABLE = true;
      pill('engMlPill', 'ready');
    } else {
      window.VIP_ML_AVAILABLE = false;
      pill('engMlPill', 'unavailable');
    }

    // Lazy AudioContext — requires user gesture
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('click', () => this.ensureCtx(), { once: true });
      document.addEventListener('keydown', () => this.ensureCtx(), { once: true });
    }

    window.__vipAppReady = true;
    if (typeof CustomEvent !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('app:ready'));
    }

    if (window._vipOrch && typeof window._vipOrch.connectApp === 'function') {
      window._vipOrch.connectApp(this);
    }
  }

  // ── DOM cache ────────────────────────────────────────────────────────────
  cacheDom() {
    const g = id => document.getElementById(id);
    this.dom = {
      fileInput:g('fileInput'),
      fileBtn:g('fileBtn'),
      dropZone:g('dropZone'),
      uploadZone:g('uploadZone'),
      clearFile:g('clearFile'),
      fileInfo:g('fileInfo'),
      fileLoadIndicator:g('fileLoadIndicator'),
      processBtn:g('processBtn'),
      reprocessBtn:g('reprocessBtn'),
      playBtn:g('playBtn'),
      tpPlay:g('tpPlay'),
      tpPause:g('tpPause'),
      tpStop:g('tpStop'),
      tpRew:g('tpRew'),
      tpFwd:g('tpFwd'),
      tpSeek:g('tpSeek'),
      tpAB:g('tpAB'),
      tpABLabel:g('tpABLabel'),
      tpSpeed:g('tpSpeed'),
      tpSpeedDown:g('tpSpeedDown'),
      tpSpeedUp:g('tpSpeedUp'),
      tpCur:g('tpCur'),
      tpDur:g('tpDur'),
      saveOrigBtn:g('saveOrigBtn'),
      saveProcBtn:g('saveProcBtn'),
      auditLogBtn:g('auditLogBtn'),
      presetSel:g('presetSel'),
      resetSlidersBtn:g('resetSlidersBtn'),
      sliderSearch:g('sliderSearch'),
      pipeFill:g('pipeFill'),
      pipeBar:g('pipeBar'),
      pipeDetail:g('pipeDetail'),
      videoPlayer:g('videoPlayer'),
      videoCard:g('videoCard'),
      hStatus:g('hStatus'),
      hDur:g('hDur'),
      hSR:g('hSR'),
      hCh:g('hCh'),
      hFile:g('hFile'),
      hPeak:g('hPeak'),
      hRMS:g('hRMS'),
      mobileProcessBtn:g('mobileProcessBtn'),
      mobileReprocessBtn:g('mobileReprocessBtn'),
      mobileStopBtn:g('mobileStopBtn'),
      statsToggle:g('statsToggle'),
      hdrStats:g('hdrStats'),
    };
  }

  // ── Boot splash ──────────────────────────────────────────────────────────
  initBootSplash() {
    const splash = $('bootSplash');
    const fill = $('bootSplashProgress');
    if (!splash) return;
    let pct = 0;
    const iv = setInterval(() => {
      pct = Math.min(pct + Math.random() * 18 + 4, 100);
      if (fill) fill.style.width = pct + '%';
      if (pct >= 100) {
        clearInterval(iv);
        setTimeout(() => {
          splash.style.transition = 'opacity 0.4s ease';
          splash.style.opacity = '0';
          setTimeout(() => { splash.style.display = 'none'; }, 420);
        }, 200);
      }
    }, 80);
  }

  // ── Model status panel ───────────────────────────────────────────────────
  initModelStatusPanel() {
    if (typeof ModelStatusUI !== 'undefined' && ModelStatusUI) {
      try {
        this._modelStatusUI = new ModelStatusUI(
          $('modelStatusPills') || document.body,
          MODEL_STATUS_KEYS,
          { healthContainer: $('cdnHealthPanel') }
        );
      } catch (e) {
        structuredLog('warn', '[VIP] ModelStatusUI init failed', { err: e.message });
      }
    }
  }

  // ── Pipeline progress ────────────────────────────────────────────────────
  updatePipelineProgress(stageIndex, detail, pct) {
    const fill = this.dom.pipeFill || $('pipeFill');
    const bar = this.dom.pipeBar || $('pipeBar');
    const detailEl = this.dom.pipeDetail || $('pipeDetail');
    const badge = $('vip-proc-badge');
    const p = typeof pct === 'number' ? pct : (stageIndex / 32) * 100;
    if (fill) fill.style.width = p + '%';
    if (bar) bar.setAttribute('aria-valuenow', p);
    if (detailEl) detailEl.textContent = detail || '';
    if (badge) badge.dataset.state = p >= 100 ? 'done' : p > 0 ? 'processing' : 'idle';
    const spinner = badge && badge.querySelector('.vip-pb-spinner');
    if (spinner) spinner.style.display = (p > 0 && p < 100) ? '' : 'none';
    const lbl = badge && badge.querySelector('.vip-pb-label');
    if (lbl) lbl.textContent = detail || (p >= 100 ? 'Done' : 'Ready');
  }

  // ── Render static visuals (waveform/spectrogram placeholder) ─────────────
  renderStaticVisuals(buffer) {
    if (typeof window.drawWaveform === 'function') {
      try { window.drawWaveform(buffer); } catch (_) {}
    }
    if (typeof window.VIP_spectro === 'object' && window.VIP_spectro) {
      try { window.VIP_spectro.renderStatic(buffer); } catch (_) {}
    }
  }

  // ── Audio context ────────────────────────────────────────────────────────
  async ensureCtx() {
    if (this._ctxReady) {
      if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    if (this._pendingCtxInit) return this._pendingCtxInit;

    this._pendingCtxInit = (async () => {
      try {
        this.ctx = this.ctx || new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
        pill('engCtxPill', 'loading');

        if (typeof SharedArrayBuffer !== 'undefined') {
          const sab = new SharedArrayBuffer(256 * Float32Array.BYTES_PER_ELEMENT);
          this.sharedParams = new Float32Array(sab);
          SLIDER_REGISTRY.forEach((s, i) => {
            this.sharedParams[i + 1] = (window.VIP_PARAMS && window.VIP_PARAMS[s.id] !== undefined) ? window.VIP_PARAMS[s.id] : (s.val || 0);
          });
        }

        this._ctxReady = true;
        this._workletReady = true;
        pill('engCtxPill', 'ready');

        this._initSABRings();
        this._updateProcessButtonsState();
        structuredLog('info', '[VIP] AudioContext ready.');
      } catch (err) {
        structuredLog('error', '[VIP] AudioContext init failed', { err: err.message });
        this._workletReady = false;
        pill('engCtxPill', 'error');
      } finally {
        this._pendingCtxInit = null;
      }
    })();

    return this._pendingCtxInit;
  }

  // Alias used by some tests
  _ensureAudioCtx() { return this.ensureCtx(); }

  // ── SAB ring buffer init ─────────────────────────────────────────────────
  _initSABRings() {
    if (typeof SharedArrayBuffer === 'undefined') return;
    const inputByteLen = SAB_HEADER_BYTES + HALF_BINS * 4 * 2;
    const outputByteLen = SAB_HEADER_BYTES + HALF_BINS * 4 * 2;
    const inputSAB = new SharedArrayBuffer(inputByteLen);
    const outputSAB = new SharedArrayBuffer(outputByteLen);
    this._inputSAB = inputSAB;
    this._outputSAB = outputSAB;
    const worker = window._vipOrch && window._vipOrch.mlWorker;
    if (worker) {
      worker.postMessage({ type: 'initRingBuffers', inputRing: inputSAB, maskRing: outputSAB }, []);
    }
    const workletNode = window._vipOrch && window._vipOrch.workletNode;
    if (workletNode) {
      workletNode.port.addEventListener('message', (ev) => {
        if (ev.data && ev.data.type === 'sabReady' && ev.data.inputSAB && ev.data.outputSAB) {
          this._inputSAB = ev.data.inputSAB;
          this._outputSAB = ev.data.outputSAB;
        }
      });
    }
  }

  // ── Slider rendering ─────────────────────────────────────────────────────
  _renderSliders() {
    const allSliders = Object.values(SLIDERS).flat();
    for (const s of allSliders) {
      const panelId = this._getSliderPanelId(s.id);
      const panel = panelId ? document.getElementById(panelId) : null;
      const container = panel || document.getElementById('sliderContainer');
      if (!container) continue;

      const row = document.createElement('div');
      row.className = 'sr-row';
      row.dataset.sliderId = s.id;

      const labelEl = document.createElement('label');
      labelEl.className = 'sr-label';
      labelEl.htmlFor = 'sl_' + s.id;
      labelEl.textContent = s.label;
      labelEl.title = s.desc || '';

      if (s.rt) {
        const badge = document.createElement('span');
        badge.className = 'rt-badge';
        badge.textContent = 'RT';
        labelEl.appendChild(badge);
      }

      const infoEl = document.createElement('span');
      infoEl.className = 'sr-info';
      infoEl.textContent = 'i';
      infoEl.setAttribute('aria-hidden', 'true');
      labelEl.appendChild(infoEl);
      // Full hover/tap tooltip with a concrete example for every control.
      infoEl.title = (s.desc || '') + (s.example ? ' — Example: ' + s.example : '');

      const inputEl = document.createElement('input');
      inputEl.type = 'range';
      inputEl.id = 'sl_' + s.id;
      inputEl.name = s.id;
      inputEl.min = s.min;
      inputEl.max = s.max;
      inputEl.step = s.step;
      const initVal = (window.VIP_PARAMS && window.VIP_PARAMS[s.id] !== undefined) ? window.VIP_PARAMS[s.id] : s.val;
      inputEl.value = initVal;
      inputEl.setAttribute('aria-label', s.label);
      inputEl.setAttribute('aria-valuenow', initVal);
      if (s.rt) inputEl.classList.add('realtime');

      const range = s.max - s.min;
      const initPct = range > 0 ? ((initVal - s.min) / range) * 100 : 0;
      inputEl.style.setProperty('--pct', `${initPct.toFixed(1)}%`);

      const valEl = document.createElement('span');
      valEl.className = 'sr-val';
      valEl.id = 'val_' + s.id;
      valEl.textContent = initVal + (s.unit || '');

      // PATCHED BY vip-fixes.js — consider merging
      inputEl.addEventListener('input', () => {
        const el = inputEl;
        const v = parseFloat(el.value);
        const min = parseFloat(el.min);
        const max = parseFloat(el.max);
        const r = parseFloat(el.max) - parseFloat(el.min);
        const pct = r > 0 ? ((v - min) / (max - min)) * 100 : 0;
        el.style.setProperty('--pct', `${pct.toFixed(1)}%`);
        el.setAttribute('aria-valuenow', v);
        valEl.textContent = v + (s.unit || '');
        window.VIP_PARAMS = window.VIP_PARAMS || {};
        window.VIP_PARAMS[s.id] = v;
        this.params[s.id] = v;
        if (this.sharedParams) {
          const idx = this._sliderIndexById.get(s.id);
          if (idx !== undefined) this.sharedParams[idx] = v;
        }
        this.onSlider(s.id, v);
      });

      // Per-control explanation (what it does + a concrete example). Collapsed
      // by default; tapping the "i" reveals it. Linked via aria-describedby so
      // screen readers announce it when the slider is focused.
      const descEl = document.createElement('div');
      descEl.className = 'sr-desc';
      descEl.id = 'desc_' + s.id;
      const descWhat = document.createElement('span');
      descWhat.className = 'sr-desc-what';
      descWhat.textContent = s.desc || '';
      descEl.appendChild(descWhat);
      if (s.example) {
        const exEl = document.createElement('span');
        exEl.className = 'sr-desc-ex';
        exEl.innerHTML = '';
        const exLabel = document.createElement('strong');
        exLabel.textContent = 'Example: ';
        exEl.appendChild(exLabel);
        exEl.appendChild(document.createTextNode(s.example));
        descEl.appendChild(exEl);
      }
      inputEl.setAttribute('aria-describedby', 'desc_' + s.id);

      infoEl.setAttribute('aria-expanded', 'false');
      const toggleDesc = (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        const open = row.classList.toggle('info-open');
        infoEl.setAttribute('aria-expanded', String(open));
      };
      infoEl.addEventListener('click', toggleDesc);

      row.appendChild(labelEl);
      row.appendChild(inputEl);
      row.appendChild(valEl);
      row.appendChild(descEl);
      container.appendChild(row);

      window.VIP_PARAMS = window.VIP_PARAMS || {};
      window.VIP_PARAMS[s.id] = initVal;
    }
  }

  _getSliderPanelId(sliderId) {
    const tabMap = {
      gate: 'tab-gate', nr: 'tab-nr', eq: 'tab-eq', dyn: 'tab-dyn',
      spec: 'tab-spec', adv: 'tab-adv', sep: 'tab-sep', out: 'tab-out',
    };
    for (const [group, panelId] of Object.entries(tabMap)) {
      if (SLIDERS[group] && SLIDERS[group].some(s => s.id === sliderId)) {
        return panelId;
      }
    }
    return null;
  }

  onSlider(id, value) {
    const orch = window._vipOrch;
    if (id === 'outGain' && this._outGainNode && this.currentSource && this.ctx) {
      const gain = Math.pow(10, value / 20);
      this._outGainNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
    }
    if (id === 'outWidth' && this.isPlaying) {
      const speed = numFromInput(this.dom && this.dom.tpSpeed, 1) || 1;
      if (this.ctx) {
        this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
      }
      const buf = this.abMode === 'processed'
        ? (this.outputBuffer || this.procBuffer || this.inputBuffer || this.origBuffer)
        : (this.inputBuffer || this.origBuffer);
      if (buf) this.playOffset = Math.max(0, Math.min(buf.duration, this.playOffset));
      this.play();
    }
    if (orch && typeof orch.onSlider === 'function') {
      orch.onSlider(id, value);
    }
  }

  // ── Event binding ────────────────────────────────────────────────────────
  bindEvents() {
    const d = this.dom;

    // Helper: safe addEventListener
    const bind = (name, el, event, fn) => {
      if (el) el.addEventListener(event, fn);
    };

    // Safe querySelectorAll — returns empty array when document is a partial mock
    const qsa = (sel) => {
      if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') return document.querySelectorAll(sel);
      return [];
    };

    // File input
    bind('fileBtn', d.fileBtn, 'click', () => { if (d.fileInput) d.fileInput.click(); });
    if (d.uploadZone) {
      d.uploadZone.addEventListener('click', () => { if (d.fileInput) d.fileInput.click(); });
      d.uploadZone.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { if (d.fileInput) d.fileInput.click(); }
      });
    }
    bind('fileInput', d.fileInput, 'change', e => this.handleFile(e.target.files[0]));
    if (d.dropZone) {
      d.dropZone.addEventListener('dragover', e => { e.preventDefault(); d.dropZone.classList.add('drag-over'); });
      d.dropZone.addEventListener('dragleave', () => d.dropZone.classList.remove('drag-over'));
      d.dropZone.addEventListener('drop', e => {
        e.preventDefault();
        d.dropZone.classList.remove('drag-over');
        this.handleFile(e.dataTransfer.files[0]);
      });
    }
    bind('clearFile', d.clearFile, 'click', () => {
      if (this.inputBuffer && !confirm('Are you sure you want to clear the workspace? Any unsaved changes will be lost.')) return;
      this._clearFile();
    });

    // Process buttons
    bind('processBtn', d.processBtn, 'click', () => this.runPipeline());
    bind('reprocessBtn', d.reprocessBtn, 'click', () => this.runPipeline());

    // Mobile action bar
    if (this.dom.mobileProcessBtn) {
      this.dom.mobileProcessBtn.addEventListener('click', () => this.runPipeline());
    }
    if (this.dom.mobileReprocessBtn) {
      this.dom.mobileReprocessBtn.addEventListener('click', () => this.runPipeline());
    }
    if (this.dom.mobileStopBtn) {
      this.dom.mobileStopBtn.addEventListener('click', () => { this.abortFlag = true; });
    }
    if (this.dom.statsToggle && this.dom.hdrStats) {
      this.dom.statsToggle.addEventListener('click', () => {
        const expanded = this.dom.hdrStats.classList.toggle('expanded');
        this.dom.statsToggle.setAttribute('aria-expanded', String(expanded));
        this.dom.statsToggle.textContent = expanded ? '▲' : '▼';
      });
    }

    // Transport
    bind('playBtn', this.dom.playBtn, 'click', () => { this.togglePlayback(); });
    bind('tpPlay', d.tpPlay, 'click', () => { this.togglePlayback(); });
    bind('tpPause', d.tpPause, 'click', () => this.pause());
    bind('tpStop', d.tpStop, 'click', () => this.stop());
    bind('tpRew', d.tpRew, 'click', () => this.seekDelta(-10));
    bind('tpFwd', d.tpFwd, 'click', () => this.seekDelta(10));
    bind('tpSeek', d.tpSeek, 'input', e => this.seekTo(parseFloat(e.target.value) / 1000));

    const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    bind('tpSpeed', d.tpSpeed, 'change', () => {
      if (this.currentSource) this.currentSource.playbackRate.value = numFromInput(d.tpSpeed, 1);
    });
    bind('tpSpeedDown', d.tpSpeedDown, 'click', () => {
      if (!d.tpSpeed) return;
      const cur = numFromInput(d.tpSpeed, 1);
      const idx = SPEEDS.indexOf(cur);
      if (idx > 0) { d.tpSpeed.value = SPEEDS[idx - 1]; d.tpSpeed.dispatchEvent(new Event('change')); }
    });
    bind('tpSpeedUp', d.tpSpeedUp, 'click', () => {
      if (!d.tpSpeed) return;
      const cur = numFromInput(d.tpSpeed, 1);
      const idx = SPEEDS.indexOf(cur);
      if (idx < SPEEDS.length - 1) { d.tpSpeed.value = SPEEDS[idx + 1]; d.tpSpeed.dispatchEvent(new Event('change')); }
    });

    // PATCHED BY vip-fixes.js — consider merging
    // A/B toggle
    bind('tpAB', d.tpAB, 'click', () => this.toggleAB());
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('keydown', e => this._handleGlobalKeydown(e));
    }

    // Save buttons
    bind('saveOrigBtn', d.saveOrigBtn, 'click', () => {
      if (this.origBuffer || this.inputBuffer) downloadWav(this.origBuffer || this.inputBuffer, 'original-' + Date.now() + '.wav');
    });
    bind('saveProcBtn', d.saveProcBtn, 'click', () => {
      if (this.procBuffer || this.outputBuffer) downloadWav(this.procBuffer || this.outputBuffer, 'processed-' + Date.now() + '.wav');
    });
    bind('auditLogBtn', d.auditLogBtn, 'click', () => this.downloadAuditLog());

    // PATCHED BY vip-fixes.js — consider merging
    // Preset selector
    bind('presetSel', d.presetSel, 'change', e => this.applyPreset(e.target.value));
    qsa('.btn-preset').forEach(b => {
      b.addEventListener('click', () => this.applyPreset(b.dataset.preset));
    });

    // Reset sliders
    bind('resetSlidersBtn', d.resetSlidersBtn, 'click', () => {
      qsa('[id^="sl_"]').forEach(el => {
        const id = el.id.slice(3);
        const spec = SLIDER_BY_ID[id];
        if (spec) { el.value = spec.val; el.dispatchEvent(new Event('input', { bubbles: true })); }
      });
    });

    // PATCHED BY vip-fixes.js — consider merging
    // Slider search
    bind('sliderSearch', d.sliderSearch, 'input', () => {
      const q = d.sliderSearch.value.trim().toLowerCase();
      qsa('.sr-row').forEach(row => {
        const label = (row.querySelector('.sr-label') || {}).textContent || '';
        row.style.display = (!q || label.toLowerCase().includes(q)) ? '' : 'none';
      });
    });

    // Tab switching
    const tabs = qsa('.tab-btn[data-tab]');
    tabs.forEach((btn, index) => {
      btn.addEventListener('click', () => {
        tabs.forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
          b.setAttribute('tabindex', '-1');
        });
        qsa('.panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        btn.setAttribute('tabindex', '0');
        const panel = document.getElementById('tab-' + btn.dataset.tab);
        if (panel) panel.classList.add('active');
      });

      btn.addEventListener('keydown', (e) => {
        let newIndex = index;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          newIndex = (index + 1) % tabs.length;
          e.preventDefault();
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          newIndex = (index - 1 + tabs.length) % tabs.length;
          e.preventDefault();
        } else if (e.key === 'Home') {
          newIndex = 0;
          e.preventDefault();
        } else if (e.key === 'End') {
          newIndex = tabs.length - 1;
          e.preventDefault();
        }

        if (newIndex !== index) {
          tabs[newIndex].focus();
          tabs[newIndex].click();
        }
      });
    });

    // UI scale controls
    let uiScale = 1;
    bind('uiScaleDn', $('uiScaleDn'), 'click', () => {
      uiScale = Math.max(0.7, uiScale - 0.05);
      if (document.body) document.body.style.zoom = uiScale;
      const v = $('uiScaleVal'); if (v) v.textContent = Math.round(uiScale * 100) + '%';
    });
    bind('uiScaleUp', $('uiScaleUp'), 'click', () => {
      uiScale = Math.min(1.4, uiScale + 0.05);
      if (document.body) document.body.style.zoom = uiScale;
      const v = $('uiScaleVal'); if (v) v.textContent = Math.round(uiScale * 100) + '%';
    });

    // Fullscreen spectrogram
    bind('fullscreenSpectroBtn', $('fullscreenSpectroBtn'), 'click', () => {
      const el = $('spectro3d-container') || $('spectroCanvas');
      if (el && el.requestFullscreen) el.requestFullscreen();
    });

    // Custom preset modal
    const _handlePresetModalKeydown = (e) => {
      const modal = $('customPresetModal');
      if (!modal || modal.style.display === 'none') return;

      if (e.key === 'Escape') {
        const closeBtn = $('closePresetModal');
        if (closeBtn) closeBtn.click();
      } else if (e.key === 'Enter') {
        // Only trigger Enter if we are in the input, to avoid conflicting with button interactions
        if (e.target && e.target.id === 'customPresetName') {
          const saveBtn = $('saveCustomPresetBtn');
          if (saveBtn) saveBtn.click();
        }
      }
    };

    bind('openPresetModalBtn', $('openPresetModalBtn'), 'click', () => {
      const modal = $('customPresetModal');
      if (modal) {
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');

        // Auto-focus input on open
        const input = $('customPresetName');
        if (input) {
          // Delay focus slightly to ensure modal is visible
          setTimeout(() => input.focus(), 10);
        }

        document.addEventListener('keydown', _handlePresetModalKeydown);
      }
    });

    bind('closePresetModal', $('closePresetModal'), 'click', () => {
      const modal = $('customPresetModal');
      if (modal) {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');

        document.removeEventListener('keydown', _handlePresetModalKeydown);

        // Return focus to trigger
        const trigger = $('openPresetModalBtn');
        if (trigger) trigger.focus();
      }
    });

    // Also remove the keydown listener when save is clicked (assuming save handles its own close/hide logic if any, but since we are handling keydown, we should also intercept save button directly to remove listener)
    bind('saveCustomPresetBtn', $('saveCustomPresetBtn'), 'click', () => {
      document.removeEventListener('keydown', _handlePresetModalKeydown);
      // Wait a tick then return focus to the trigger if modal is closed (in case save logic closes it)
      setTimeout(() => {
        const modal = $('customPresetModal');
        if (modal && modal.style.display === 'none') {
          const trigger = $('openPresetModalBtn');
          if (trigger) trigger.focus();
        }
      }, 50);
    });

    // Forensic toggle
    bind('forensicToggle', $('forensicToggle'), 'click', () => this.showNotification('Forensic mode: set in Advanced sliders.', 'info'));
  }

  // ── Global keyboard shortcuts ────────────────────────────────────────────
  _handleGlobalKeydown(e) {
    const target = e.target;
    if (!target) return;

    const tag = target.tagName;
    const contentEditable = target.isContentEditable;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || contentEditable;

    // Do not intercept if interacting with a button or a tablist component
    const inButtonOrTab = tag === 'BUTTON' || (typeof target.closest === 'function' && target.closest('[role="tablist"]'));

    if (inInput || inButtonOrTab) return;

    if ((e.key === ' ' || e.key === 'k' || e.key === 'K') && (this.inputBuffer || this.origBuffer)) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      this.togglePlayback();
      return;
    }
    if (e.key === 'Escape') {
      if (this.isProcessing) {
        this.abortFlag = true;
      } else {
        this.stop();
      }
      return;
    }
    if (e.key === 'x' || e.key === 'X') {
      if (!(this.outputBuffer || this.procBuffer)) return;
      if (this.dom && this.dom.tpAB && this.dom.tpAB.disabled) return;
      this.toggleAB();
      return;
    }
    if (e.key === 'ArrowLeft') { this.seekDelta(-5); return; }
    if (e.key === 'ArrowRight') { this.seekDelta(5); return; }
  }

  // ── Preset application ────────────────────────────────────────────────────
  applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) return;
    Object.entries(preset).forEach(([key, rawValue]) => {
      if (key === 'description') return;
      const sliderId = key;
      const value = SLIDER_BY_ID[sliderId] ? clampToSlider(sliderId, rawValue) : rawValue;
      window.VIP_PARAMS = window.VIP_PARAMS || {};
      window.VIP_PARAMS[key] = value;
      this.params[key] = value;
      const sliderDom = { el: document.getElementById('sl_' + key) };
      if (!sliderDom.el) return;
      sliderDom.el.value = value;
      sliderDom.el.setAttribute('aria-valuenow', value);
      const min = parseFloat(sliderDom.el.min);
      const max = parseFloat(sliderDom.el.max);
      const range = max - min;
      const pct = range > 0 ? ((value - min) / range) * 100 : 0;
      sliderDom.el.style.setProperty('--pct', `${pct.toFixed(1)}%`);
      sliderDom.el.dispatchEvent(new Event('input', { bubbles: true }));
      sliderDom.el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    if (this.liveChainBuilt) {
      // Sync params to worklet after preset application
      if (window._vipOrch && typeof window._vipOrch.syncParams === 'function') {
        window._vipOrch.syncParams(window.VIP_PARAMS || {});
      }
    }
    this.showNotification('Preset applied: ' + name, 'info');
  }

  // ── File handling ─────────────────────────────────────────────────────────
  async handleFile(file) {
    if (!file) return;
    this.stop();
    this.setStatus('LOADING');
    if (this.dom && this.dom.fileInfo) this.dom.fileInfo.textContent = file.name;

    await this.ensureCtx();

    // Reject MIDI files early — not supported by Web Audio API
    const midiMimes = ['audio/midi', 'audio/x-midi', 'audio/mid'];
    const isMidi = midiMimes.includes((file.type || '').toLowerCase()) ||
      /\.(mid|midi)$/i.test(file.name || '');
    if (isMidi) {
      if (this.dom && this.dom.fileInfo) this.dom.fileInfo.textContent = 'MIDI files are not supported. Use an audio file (WAV, MP3, etc).';
      this.setStatus('ERROR');
      return;
    }

    // Reject clearly non-audio/non-video MIME types
    const isAudio = !file.type || file.type.startsWith('audio/') || file.type.startsWith('video/');
    if (!isAudio) {
      if (this.dom && this.dom.fileInfo) this.dom.fileInfo.textContent = 'Unsupported file type: ' + (file.type || 'unknown');
      this.setStatus('ERROR');
      return;
    }

    // Detect video by MIME type or container extension. The <video> element is
    // then shown and kept in sync with the Web Audio transport so the picture
    // plays alongside the *processed* audio (video stays muted; sound comes
    // from the processed/original AudioBuffer). decodeAudioData demuxes the
    // audio track from most MP4/WEBM/MOV containers directly.
    const isVideoFile = (file.type && file.type.startsWith('video/')) ||
      /\.(mp4|m4v|mov|webm|mkv|avi|ogv|3gp)$/i.test(file.name || '');

    // Release any previously-loaded video source first, so reloading a new clip
    // neither leaks the old object URL nor leaves the old picture on screen.
    if (this.dom && this.dom.videoPlayer && this.dom.videoPlayer.src) {
      const prev = this.dom.videoPlayer;
      try { URL.revokeObjectURL(prev.src); } catch { /* ignore */ }
      try {
        if (typeof prev.removeAttribute === 'function') prev.removeAttribute('src');
        else prev.src = '';
      } catch { /* ignore */ }
    }

    let buffer;
    try {
      const ab = await file.arrayBuffer();
      // Copy the ArrayBuffer so the original is not detached/consumed
      const abCopy = ab.slice(0);
      buffer = await this.ctx.decodeAudioData(abCopy);
    } catch (err) {
      // Video fallback
      if (isVideoFile) {
        try {
          buffer = await this.decodeViaVideoElement(file);
          if (buffer && this.dom && this.dom.videoPlayer) {
            this.dom.videoPlayer.src = URL.createObjectURL(file);
          }
          if (this.dom && this.dom.videoCard) this.dom.videoCard.style.display = '';
          this.isVideo = true;
        } catch (vidErr) {
          if (this.dom && this.dom.fileInfo) this.dom.fileInfo.textContent = 'Cannot decode this video format';
          this.setStatus('ERROR');
          this.showNotification('Cannot decode: ' + file.name, 'error');
          return;
        }
      } else {
        if (this.dom && this.dom.fileInfo) this.dom.fileInfo.textContent = 'Cannot decode this audio format';
        this.setStatus('ERROR');
        this.showNotification('Cannot decode: ' + file.name, 'error');
        return;
      }
    }

    // Check for empty/null decoded buffer
    if (!buffer || !buffer.length) {
      if (this.dom && this.dom.fileInfo) this.dom.fileInfo.textContent = 'Decoded audio is empty or unreadable.';
      this.setStatus('ERROR');
      return;
    }

    // Show & wire the <video> element for video files (covers the common path
    // where decodeAudioData succeeded). The transport plays the processed audio
    // through Web Audio while the muted video supplies the picture in sync.
    if (isVideoFile && this.dom && this.dom.videoPlayer) {
      this.isVideo = true;
      try {
        if (!this.dom.videoPlayer.src) {
          this.dom.videoPlayer.src = URL.createObjectURL(file);
        }
      } catch { /* ignore */ }
      this.dom.videoPlayer.muted = true;
      if (this.dom.videoCard) this.dom.videoCard.style.display = '';
    } else {
      this.isVideo = false;
      if (this.dom && this.dom.videoPlayer) {
        const vp = this.dom.videoPlayer;
        try {
          if (vp.src) { try { URL.revokeObjectURL(vp.src); } catch { /* ignore */ } }
          if (typeof vp.removeAttribute === 'function') vp.removeAttribute('src');
          else vp.src = '';
        } catch { /* ignore */ }
      }
      if (this.dom && this.dom.videoCard) this.dom.videoCard.style.display = 'none';
    }

    this.inputBuffer = buffer;
    this.origBuffer = buffer;
    this.onAudioLoaded(file.name);
  }

  async decodeViaVideoElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      if (this.dom.videoPlayer) {
        this.dom.videoPlayer.src = url;
        this.dom.videoPlayer.onloadedmetadata = () => resolve(this.inputBuffer || null);
        this.dom.videoPlayer.onerror = () => reject(new Error('Video decode failed'));
        setTimeout(() => reject(new Error('Video decode timeout')), 10000);
      } else {
        reject(new Error('No video player element'));
      }
    });
  }

  onAudioLoaded(name) {
    const buf = this.inputBuffer || this.origBuffer;
    if (!buf) return;

    this.setStatus('READY');

    // Button states — set before updating header stats
    if (this.dom.processBtn) this.dom.processBtn.disabled = false;
    if (this.dom.mobileProcessBtn) this.dom.mobileProcessBtn.disabled = false;
    if (this.dom.reprocessBtn) this.dom.reprocessBtn.disabled = true;
    if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.disabled = true;
    if (this.dom.playBtn) this.dom.playBtn.disabled = false;
    if (this.dom.saveOrigBtn) this.dom.saveOrigBtn.disabled = false;

    // Header stats
    if (this.dom.hDur) this.dom.hDur.textContent = fmtTime(buf.duration);
    if (this.dom.hSR) this.dom.hSR.textContent = buf.sampleRate + ' Hz';
    if (this.dom.hCh) this.dom.hCh.textContent = buf.numberOfChannels === 1 ? 'Mono' : 'Stereo';
    if (this.dom.hFile) this.dom.hFile.textContent = (name || '').slice(0, 20);

    this.renderStaticVisuals(buf);
    try { window.dispatchEvent(new CustomEvent('vip:fileLoaded', { detail: { name } })); } catch (_) {}
    this.showNotification('File loaded: ' + name, 'info');
  }

  _clearFile() {
    this.stop();
    this.inputBuffer = null;
    this.outputBuffer = null;
    this.origBuffer = null;
    this.procBuffer = null;
    this.isVideo = false;
    if (this.dom && this.dom.videoPlayer) {
      const vp = this.dom.videoPlayer;
      try {
        if (typeof vp.pause === 'function') vp.pause();
        if (vp.src) { try { URL.revokeObjectURL(vp.src); } catch { /* ignore */ } }
        if (typeof vp.removeAttribute === 'function') vp.removeAttribute('src');
        else vp.src = '';
      } catch { /* ignore */ }
    }
    if (this.dom && this.dom.videoCard) this.dom.videoCard.style.display = 'none';
    if (this.dom.fileInfo) this.dom.fileInfo.textContent = 'No file loaded';
    if (this.dom.fileInput) this.dom.fileInput.value = '';
    [this.dom.processBtn, this.dom.reprocessBtn, this.dom.saveProcBtn,
     this.dom.saveOrigBtn, this.dom.auditLogBtn,
     this.dom.mobileProcessBtn, this.dom.mobileReprocessBtn].forEach(b => {
      if (b) b.disabled = true;
    });
    this.setStatus('IDLE');
  }

  setStatus(s) {
    this._setHeaderStat('hStatus', s);
  }

  // ── Main pipeline (32-stage Deca-Pass) ────────────────────────────────────
  async runPipeline() {
    if (!this.origBuffer && !this.inputBuffer) return;
    if (this.isProcessing) return;

    this.isProcessing = true;
    this.abortFlag = false;

    // Hide process buttons, show stop button
    if (this.dom.mobileProcessBtn) {
      this.dom.mobileProcessBtn.style.display = 'none';
    }
    if (this.dom.mobileReprocessBtn) {
      this.dom.mobileReprocessBtn.style.display = 'none';
    }
    if (this.dom.mobileStopBtn) {
      this.dom.mobileStopBtn.style.display = 'inline-flex';
    }

    this.setStatus('PROCESSING');
    this.updatePipelineProgress(0, 'Starting 32-Stage Deca-Pass…', 0);

    try {
      // Delegate to pipeline-orchestrator if available
      if (window._vipOrch && typeof window._vipOrch.run === 'function') {
        const buf = this.inputBuffer || this.origBuffer;
        const result = await window._vipOrch.run(buf, window.VIP_PARAMS || {});
        if (result) {
          this.outputBuffer = result;
          this.procBuffer = result;
        }
      } else {
        await this._runFallbackPipeline();
      }

      // Success — enable reprocess
      this.outputBuffer = this.outputBuffer || this.procBuffer;
      if (this.dom.reprocessBtn) this.dom.reprocessBtn.disabled = false;
      if (this.dom.mobileReprocessBtn) this.dom.mobileReprocessBtn.disabled = false;
      if (this.dom.saveProcBtn) this.dom.saveProcBtn.disabled = false;
      if (this.dom.auditLogBtn) this.dom.auditLogBtn.disabled = false;

      if (this.outputBuffer) this.renderStaticVisuals(this.outputBuffer);
      this.updatePipelineProgress(32, 'Complete', 100);
      this.setStatus('DONE');
      try { window.dispatchEvent(new CustomEvent('vip:processingDone')); } catch (_) {}
      this.showNotification('Processing complete!', 'info');
    } catch (err) {
      structuredLog('error', '[VIP] Pipeline error', { err: err.message });
      this.setStatus('ERROR');
      this.showNotification('Processing failed: ' + err.message, 'error');
      this.updatePipelineProgress(0, 'Error', 0);
    } finally {
      this.isProcessing = false;
      this._updateProcessButtonsState();
      if (this.dom.mobileProcessBtn) {
        this.dom.mobileProcessBtn.style.display='inline-flex';
      }
      if (this.dom.mobileReprocessBtn) {
        this.dom.mobileReprocessBtn.style.display='inline-flex';
      }
      if (this.dom.mobileStopBtn) {
        this.dom.mobileStopBtn.style.display='none';
      }
    }
  }

  async pip() {
    // Alias — kept for compatibility
    return this.runPipeline();
  }

  // Full offline DSP chain (32-stage Deca-Pass). Every capability is wired to
  // its slider in window.VIP_PARAMS and runs through the tested DSPCore
  // primitives:
  //   S03 DC offset · S05/06 noise gate · S09 de-ess · S10–S20 spectral
  //   isolation (single STFT/iSTFT) · S15 crosstalk · S22 HP/LP · S23 10-band
  //   EQ · S24 compressor · S25 limiter · S31 phase/width · S28 dry-wet ·
  //   output trim · safety limiter · dither.
  async _runFallbackPipeline() {
    const buf = this.inputBuffer || this.origBuffer;
    if (!buf) return;

    await this.ensureCtx();
    const DSP = this._resolveDSP();
    const p = window.VIP_PARAMS || {};
    const sr = buf.sampleRate;
    const nCh = buf.numberOfChannels;
    const len = buf.length;

    if (!DSP || !this.ctx || typeof this.ctx.createBuffer !== 'function') {
      // No DSP runtime — passthrough so playback still works.
      this.procBuffer = buf;
      this.outputBuffer = buf;
      return;
    }

    // Writable copy of every channel (.slice() is a fast typed-array memcpy).
    const channels = [];
    for (let ch = 0; ch < nCh; ch++) channels.push(buf.getChannelData(ch).slice());

    // ── Pass 1–2: input conditioning + time-domain cleanup (per channel) ──
    this.updatePipelineProgress(3, 'Conditioning input…', 8);
    for (let ch = 0; ch < nCh; ch++) {
      let data = channels[ch];
      // S03 DC-offset removal — always (harmless, kills sub-sonic rumble).
      DSP.removeDCOffset(data, sr);
      // S05/S06 noise gate.
      const gateThresh = p.gateThresh ?? -42;
      if (gateThresh > -80) {
        data = DSP.noiseGate(data, {
          threshold: gateThresh,
          range: p.gateRange ?? -60,
          attack: p.gateAttack ?? 5,
          release: p.gateRelease ?? 200,
          hold: p.gateHold ?? 50,
          lookahead: p.gateLookahead ?? 5,
        }, sr);
      }
      // S09 de-esser (pre-spectral).
      if ((p.deEssAmt ?? 0) > 0) DSP.deEss(data, p.deEssFreq ?? 6000, p.deEssAmt ?? 0, sr);
      channels[ch] = data;
    }
    await this._yield();

    // ── Pass 3–5: spectral isolation — ONE STFT/iSTFT per channel ──
    this.updatePipelineProgress(10, 'Spectral isolation…', 32);
    for (let ch = 0; ch < nCh; ch++) {
      channels[ch] = this._spectralStage(channels[ch], sr, p) || channels[ch];
      await this._yield();
    }

    // S15 crosstalk cancellation (needs both channels).
    if (nCh >= 2 && (p.crosstalkCancel ?? 0) > 0) {
      this._applyStereoCrosstalk(channels, (p.crosstalkCancel ?? 0) / 100);
    }

    // ── Pass 7–8: filters, EQ, dynamics (per channel) ──
    this.updatePipelineProgress(21, 'EQ + dynamics…', 62);
    for (let ch = 0; ch < nCh; ch++) {
      this._eqDynamicsStage(channels[ch], sr, p);
      await this._yield();
    }

    // ── Pass 9: stereo image (phase correlation + width) ──
    if (nCh >= 2) {
      if ((p.phaseCorr ?? 0) > 0) this._applyPhaseCorrection(channels, (p.phaseCorr ?? 0) / 100);
      const widthPct = ((p.stereoWidth ?? 100) / 100) * ((p.outWidth ?? 100) / 100) * 100;
      if (Math.abs(widthPct - 100) > 0.5) {
        const w = DSP.stereoWiden(channels[0], channels[1], widthPct);
        channels[0] = w.left; channels[1] = w.right;
      }
    }

    // Assemble the processed AudioBuffer.
    this.updatePipelineProgress(28, 'Rendering output…', 88);
    let processed = this.ctx.createBuffer(nCh, len, sr);
    for (let ch = 0; ch < nCh; ch++) {
      const src = channels[ch];
      processed.getChannelData(ch).set(src.length === len ? src : src.subarray(0, len));
    }

    // S28 dry/wet blend with the untouched original.
    const dryWetPct = Math.max(0, Math.min(100, p.dryWet ?? 100));
    if (dryWetPct < 100) processed = this.mixDW(buf, processed, dryWetPct / 100);

    // Output gain trim.
    const outGainDb = p.outGain ?? 0;
    if (outGainDb !== 0) {
      const gain = Math.pow(10, outGainDb / 20);
      for (let ch = 0; ch < processed.numberOfChannels; ch++) {
        const out = processed.getChannelData(ch);
        for (let i = 0; i < out.length; i++) out[i] *= gain;
      }
    }

    // Final brickwall safety limit + optional dither.
    const ceil = Math.min(p.limThresh ?? -1, -0.1);
    for (let ch = 0; ch < processed.numberOfChannels; ch++) {
      const out = processed.getChannelData(ch);
      DSP.truePeakLimit(out, ceil);
      if ((p.ditherAmt ?? 0) > 0) this.applyDither(out, p);
    }

    this.procBuffer = processed;
    this.outputBuffer = processed;
  }

  // Yield to the event loop between heavy passes so the processing overlay /
  // spinner keeps animating and the page stays responsive.
  _yield() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  // ── Old process() alias ───────────────────────────────────────────────────
  async process() {
    return this.runPipeline();
  }

  // ── ML model loading ──────────────────────────────────────────────────────
  async loadModels() {
    const ort = (typeof window !== 'undefined' && window.ort) || (typeof globalThis !== 'undefined' && globalThis.ort);
    if (!ort || !ort.InferenceSession) {
      structuredLog('warn', '[VIP] ONNX Runtime unavailable');
      this._dspOnlyMode = true;
      window.VIP_ML_AVAILABLE = false;
      pill('engMlPill', 'unavailable');
      return null;
    }
    let session = null;
    try {
      ort.env.wasm.wasmPaths = './';
      // Try WebGPU first, fall back to WASM-only
      try {
        session = await ort.InferenceSession.create('./models/rnnoise_suppressor.onnx', {
          executionProviders: ['webgpu', 'wasm'],
        });
      } catch (_gpuErr) {
        session = await ort.InferenceSession.create('./models/rnnoise_suppressor.onnx', {
          executionProviders: ['wasm'],
        });
      }
      this._onnxSession = session;
      this._onnxReady = true;
      this._dspOnlyMode = false;
      window.VIP_ML_AVAILABLE = true;
      pill('engMlPill', 'ready');
      // Notify ml-worker of successful session setup
      if (this._mlWorker) {
        this._mlWorker.postMessage({ type: 'init', session, });
      }
      return session;
    } catch (err) {
      structuredLog('warn', '[VIP] ONNX load failed — DSP-only mode', { err: err.message });
      this._onnxReady = false;
      this._dspOnlyMode = true;
      window.VIP_ML_AVAILABLE = false;
      pill('engMlPill', 'unavailable');
      return null;
    }
  }

  // ── VAD ───────────────────────────────────────────────────────────────────
  async runVAD(buffer, params) {
    const p = params || window.VIP_PARAMS || {};
    try {
      const result = await this._mlCall({ type: 'vad', buffer: buffer.getChannelData(0).buffer }, [buffer.getChannelData(0).buffer.slice(0)]);
      return result;
    } catch (_) {
      // Fallback: simple energy-based VAD
      return this._simpleVAD(buffer, p);
    }
  }

  _simpleVAD(buffer, _p) {
    const d = buffer.getChannelData(0);
    const threshold = 0.01;
    const segments = [];
    for (let i = 0; i < d.length; i += 1024) {
      let rms = 0;
      const end = Math.min(i + 1024, d.length);
      for (let j = i; j < end; j++) rms += d[j] * d[j];
      rms = Math.sqrt(rms / (end - i));
      if (rms > threshold) segments.push({ start: i, end });
    }
    return segments;
  }

  // ── Source separation ─────────────────────────────────────────────────────
  async runSeparation(buffer, params) {
    const p = params || window.VIP_PARAMS || {};
    const iso = p.voiceIso || 80;
    try {
      const channelData = buffer.getChannelData(0);
      const transfer = channelData.buffer.slice(0);
      const result = await this._mlCall({ type: 'separate', buffer: transfer, voiceIso: iso }, [transfer]);
      return result;
    } catch (err) {
      structuredLog('warn', '[VIP] runSeparation failed, returning original', { err: err.message });
      return null;
    }
  }

  // ── ML call helper ────────────────────────────────────────────────────────
  _mlCall(payload, transfer = []) {
    return new Promise((resolve, reject) => {
      const worker = window._vipOrch && window._vipOrch.mlWorker;
      if (!worker) { reject(new Error('ML worker unavailable')); return; }
      const id = ++this._mlCallId;
      const handler = (e) => {
        if (e.data && e.data._id === id) {
          worker.removeEventListener('message', handler);
          resolve(e.data);
        }
      };
      worker.addEventListener('message', handler);
      payload._id = id;
      worker.postMessage(payload, transfer);
    });
  }

  // ── DSP spectral operations ───────────────────────────────────────────────

  applySpectralNR(spec, params) {
    const p = params || {};
    const amt = (p.nrAmount || 0) / 100;
    const sens = p.nrSensitivity || 60;
    const sub = p.nrSpectralSub || 50;
    for (let i = 0; i < spec.length; i++) {
      spec[i] *= (1 - amt * sens / 100);
      spec[i] *= (1 - (amt * sub / 100) * 0.1);
    }
  }

  applyBgSuppress(spec, p) {
    const g = 1 - (p.bgSuppress || 0) / 100;
    for (let i = 0; i < spec.length; i++) spec[i] *= g;
  }

  applyDereverb(spec, p) {
    const amt = (p.derevAmt || 0) / 100;
    const decay = (p.derevDecay || 50) / 100;
    for (let i = 0; i < spec.length; i++) spec[i] *= (1 - amt * decay);
  }

  applyFormantShift(spec, p) {
    if (!p.formantShift) return;
    // Formant shift via spectral envelope warping
    const shift = p.formantShift;
    if (Math.abs(shift) < 0.01) return;
  }

  applyPhaseCorr(spec, p) {
    if (!p.phaseCorr) return;
    // Phase correlation correction
    const strength = (p.phaseCorr || 0) / 100;
    if (strength < 0.001) return;
  }

  applyCrosstalkCancel(spec, p) {
    if (!p.crosstalkCancel) return;
    // Crosstalk cancellation
    const strength = (p.crosstalkCancel || 0) / 100;
    if (strength < 0.001) return;
  }

  applyDither(buf, p) {
    const bits = p.ditherAmt || 0;
    if (!bits) return;
    const amp = Math.pow(2, -(bits * 8)) * 0.5;
    for (let i = 0; i < buf.length; i++) {
      buf[i] += (Math.random() * 2 - 1) * amp;
    }
  }

  applyVoiceFocus(spec, p) {
    // Soft-mask bins outside the voice focus band
    const lo = p.voiceFocusLo || 120;
    const hi = p.voiceFocusHi || 3400;
    if (!lo && !hi) return;
    // This is a spectral-domain operation; bin indices depend on sample rate
    // Implementation deferred to pipeline-orchestrator
  }

  // ── In-place Cooley-Tukey FFT ─────────────────────────────────────────────
  _fft(re, im) {
    const n = re.length;
    // Bit-reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    // Butterfly passes
    for (let len = 2; len <= n; len <<= 1) {
      const wRe = Math.cos(-2 * Math.PI / len);
      const wIm = Math.sin(-2 * Math.PI / len);
      for (let i = 0; i < n; i += len) {
        let ur = 1, ui = 0;
        for (let j = 0; j < len / 2; j++) {
          const uRe = re[i + j + len / 2] * ur - im[i + j + len / 2] * ui;
          const uIm = re[i + j + len / 2] * ui + im[i + j + len / 2] * ur;
          re[i + j + len / 2] = re[i + j] - uRe;
          im[i + j + len / 2] = im[i + j] - uIm;
          re[i + j] += uRe;
          im[i + j] += uIm;
          const newUr = ur * wRe - ui * wIm;
          ui = ur * wIm + ui * wRe;
          ur = newUr;
        }
      }
    }
  }

  _ifft(re, im) {
    // Conjugate, forward FFT, conjugate, scale
    for (let i = 0; i < im.length; i++) im[i] = -im[i];
    this._fft(re, im);
    for (let i = 0; i < im.length; i++) im[i] = -im[i];
    const n = re.length;
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  _makeWindow(N) {
    const w = new Float32Array(N);
    for (let i = 0; i < N; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / N));
    return w;
  }

  // ── Offline STFT / iSTFT (single-pass — Rule §1) ──────────────────────────
  // Exactly ONE forward STFT and ONE inverse STFT per offline processing path.
  // This method is the sole caller of DSP.forwardSTFT and DSP.inverseSTFT in app.js.

  _resolveDSP() {
    if (typeof globalThis !== 'undefined' && 'DSPCore' in globalThis) return globalThis.DSPCore || null;
    if (typeof window !== 'undefined' && 'DSPCore' in window) return window.DSPCore || null;
    return null;
  }

  // S10–S20: spectral isolation on a single channel. Exactly ONE forward STFT
  // and ONE inverse STFT — the single-pass spectral contract (CLAUDE.md §1).
  // All in-between stages mutate the magnitude frames in place.
  _spectralStage(data, sr, p) {
    const DSP = this._resolveDSP();
    const FFT = 4096;
    const HOP = 1024;
    // Clips shorter than one analysis window have no spectral frames.
    if (!DSP || !data || data.length < FFT) return data;

    // SINGLE-PASS STFT BOUNDARY — the only forward transform on this path.
    const spec = DSP.forwardSTFT(data, FFT, HOP);
    if (!spec || !Array.isArray(spec.mag) || spec.mag.length === 0) return data;
    const mag = spec.mag;
    const phase = spec.phase;
    const halfN = mag[0].length;

    // S11 adaptive Wiener noise reduction (nrAmount, shaped by sensitivity/sub).
    const nrAmount = p.nrAmount ?? 0;
    if (nrAmount > 0) {
      const noise = this._estimateNoiseFloor(mag);
      const scale = 1 + (p.nrSensitivity ?? 60) / 100 * 0.6 + (p.nrSpectralSub ?? 50) / 100 * 0.6;
      for (let k = 0; k < noise.length; k++) noise[k] *= scale;
      DSP.wienerMMSE(mag, noise, nrAmount);
    }

    // S13 ERB-band spectral gate down to the NR floor.
    if ((p.nrFloor ?? -96) > -96) DSP.spectralGate(mag, p.nrFloor ?? -72, sr, HOP);

    // S14 voice focus / isolation + background suppression.
    this._applyVoiceFocus(mag, sr, p, halfN, FFT);

    // S16 temporal smoothing (suppress musical noise).
    if ((p.nrSmoothing ?? 0) > 0) DSP.temporalSmooth(mag, p.nrSmoothing);

    // S17 spectral tilt.
    if (Math.abs(p.specTilt ?? 0) > 0.01) this._applySpectralTilt(mag, sr, p.specTilt, halfN, FFT);

    // Formant shift (envelope warp; pitch unchanged because phase is kept).
    if (Math.abs(p.formantShift ?? 0) > 0.01) this._applyFormantShiftSpec(mag, p.formantShift, halfN);

    // S18 dereverb.
    if ((p.derevAmt ?? 0) > 0) {
      const decaySec = 0.12 + (p.derevDecay ?? 50) / 100 * 0.68; // ~0.12–0.8 s
      DSP.dereverb(mag, p.derevAmt, decaySec, sr, HOP);
    }

    // S19 harmonic reconstruction.
    if ((p.harmRecov ?? 0) > 0) DSP.harmonicEnhance(mag, phase, p.harmRecov);

    // SINGLE-PASS STFT BOUNDARY — the only inverse transform on this path.
    const rendered = DSP.inverseSTFT(mag, phase, FFT, HOP, data.length);
    return (rendered && rendered.length === data.length) ? rendered : data;
  }

  // Per-bin stationary-noise estimate via minimum statistics across frames.
  _estimateNoiseFloor(mag) {
    const halfN = mag[0].length;
    const floor = new Float32Array(halfN).fill(Infinity);
    for (let f = 0; f < mag.length; f++) {
      const frame = mag[f];
      for (let k = 0; k < halfN; k++) if (frame[k] < floor[k]) floor[k] = frame[k];
    }
    for (let k = 0; k < halfN; k++) floor[k] = Number.isFinite(floor[k]) ? floor[k] * 1.6 : 0;
    return floor;
  }

  // S14: keep the voice band (voiceFocusLo..Hi) plus the speech-shaped mask;
  // attenuate everything else by bgSuppress, weighted by voiceIso.
  _applyVoiceFocus(mag, sr, p, halfN, fftSize) {
    const DSP = this._resolveDSP();
    const iso = (p.voiceIso ?? 0) / 100;
    const bg = (p.bgSuppress ?? 0) / 100;
    if (iso <= 0 && bg <= 0) return;
    const lo = p.voiceFocusLo ?? 120;
    const hi = p.voiceFocusHi ?? 3400;
    const gains = new Float32Array(halfN);
    for (let k = 0; k < halfN; k++) {
      const freq = k * sr / fftSize;
      let g = 1;
      if (freq < lo || freq > hi) g *= (1 - bg * 0.92);
      if (iso > 0 && DSP && typeof DSP.getVoiceMaskGain === 'function') {
        const vm = DSP.getVoiceMaskGain(k, sr, fftSize);
        g *= (1 - iso) + iso * vm;
      }
      gains[k] = g;
    }
    for (let f = 0; f < mag.length; f++) {
      const frame = mag[f];
      for (let k = 0; k < halfN; k++) frame[k] *= gains[k];
    }
  }

  // S17: linear spectral tilt; +dB brightens (boost highs, cut lows), −dB darkens.
  _applySpectralTilt(mag, sr, tiltDb, halfN, fftSize) {
    const nyq = sr / 2;
    const gains = new Float32Array(halfN);
    for (let k = 0; k < halfN; k++) {
      const frac = (k * sr / fftSize) / nyq; // 0..1
      gains[k] = Math.pow(10, (tiltDb * (frac - 0.5)) / 20);
    }
    for (let f = 0; f < mag.length; f++) {
      const frame = mag[f];
      for (let k = 0; k < halfN; k++) frame[k] *= gains[k];
    }
  }

  // Formant shift: resample the magnitude envelope by 2^(st/12). Phase frames
  // are untouched so pitch is preserved while vocal character moves.
  _applyFormantShiftSpec(mag, semitones, halfN) {
    const factor = Math.pow(2, semitones / 12);
    if (!Number.isFinite(factor) || factor <= 0) return;
    const out = new Float32Array(halfN);
    for (let f = 0; f < mag.length; f++) {
      const src = mag[f];
      for (let k = 0; k < halfN; k++) {
        const pos = k / factor;
        const i0 = Math.floor(pos);
        if (i0 < 0 || i0 >= halfN) { out[k] = 0; continue; }
        const i1 = Math.min(i0 + 1, halfN - 1);
        const t = pos - i0;
        out[k] = src[i0] * (1 - t) + src[i1] * t;
      }
      src.set(out);
    }
  }

  // S15: cancel the bleed of each stereo channel into the other.
  _applyStereoCrosstalk(channels, amount) {
    const L = channels[0], R = channels[1];
    const n = Math.min(L.length, R.length);
    const k = Math.max(0, Math.min(1, amount)) * 0.5;
    const Lc = L.slice(), Rc = R.slice();
    for (let i = 0; i < n; i++) {
      L[i] = Lc[i] - k * Rc[i];
      R[i] = Rc[i] - k * Lc[i];
    }
  }

  // Phase-correlation correction — pull out-of-phase stereo content toward the
  // mono centre so the mix stays solid when summed to mono.
  _applyPhaseCorrection(channels, amount) {
    const L = channels[0], R = channels[1];
    const n = Math.min(L.length, R.length);
    const a = Math.max(0, Math.min(1, amount));
    for (let i = 0; i < n; i++) {
      const mid = (L[i] + R[i]) * 0.5;
      L[i] = L[i] * (1 - a) + mid * a;
      R[i] = R[i] * (1 - a) + mid * a;
    }
  }

  // S22–S25: HP/LP filters, 10-band parametric EQ, compressor, limiter.
  _eqDynamicsStage(data, sr, p) {
    const DSP = this._resolveDSP();
    if (!DSP) return data;

    // S22 high-pass / low-pass.
    const hpFreq = p.hpFreq ?? 20;
    if (hpFreq > 20) DSP.biquadProcess(data, DSP.biquadCoeffs('highpass', hpFreq, p.hpQ ?? 0.7, 0, sr));
    const lpFreq = p.lpFreq ?? 20000;
    if (lpFreq < 20000) DSP.biquadProcess(data, DSP.biquadCoeffs('lowpass', lpFreq, p.lpQ ?? 0.7, 0, sr));

    // S23 10-band parametric EQ.
    const eqBands = [
      ['eqSub', 40], ['eqBass', 120], ['eqWarmth', 300], ['eqBody', 700], ['eqLowMid', 1500],
      ['eqMid', 3000], ['eqPresence', 5000], ['eqClarity', 8000], ['eqAir', 13000], ['eqBrill', 18000],
    ].map(([id, freq]) => ({ freq, gain: p[id] ?? 0, Q: 1.0, type: 'peaking' }))
      .filter((b) => b.freq < sr / 2);
    DSP.parametricEQ(data, eqBands, sr);

    // S24 compressor (+ makeup gain).
    if ((p.compRatio ?? 1) > 1.01) {
      DSP.compress(data, {
        threshold: p.compThresh ?? -24,
        ratio: p.compRatio ?? 4,
        attack: p.compAttack ?? 10,
        release: p.compRelease ?? 150,
        knee: Math.max(0.5, p.compKnee ?? 6),
        makeup: p.compMakeup ?? 0,
      }, sr);
    } else if ((p.compMakeup ?? 0) > 0) {
      const g = Math.pow(10, (p.compMakeup ?? 0) / 20);
      for (let i = 0; i < data.length; i++) data[i] *= g;
    }

    // S25 limiter.
    DSP.truePeakLimit(data, p.limThresh ?? -1);
    return data;
  }

  // Live-microphone ingestion was REMOVED by design (CLAUDE.md §1.1).
  // navigator.mediaDevices.getUserMedia is forbidden in this codebase; the
  // Permissions-Policy header denies the microphone entirely.

  // ── Transport ─────────────────────────────────────────────────────────────
  play() {
    this.ensureCtx();
    const buf = this.abMode === 'processed'
      ? (this.outputBuffer || this.procBuffer || this.inputBuffer || this.origBuffer)
      : (this.inputBuffer || this.origBuffer);
    if (!buf) return;

    this.isPlaying = true;
    this.playStartTime = this.ctx ? this.ctx.currentTime : 0;

    // PATCHED BY vip-fixes.js — consider merging
    if (this.dom && this.dom.tpABLabel) {
      this.dom.tpABLabel.textContent = this.abMode === 'processed' ? 'Processed' : 'Original';
    }

    this.buildLiveChain(buf);

    if (this.isVideo && this.dom && this.dom.videoPlayer) {
      const vp = this.dom.videoPlayer;
      vp.currentTime = this.playOffset;
      vp.playbackRate = numFromInput(this.dom.tpSpeed, 1);
      vp.muted = true;
      vp.play && vp.play().catch(() => {});
    }

    if (typeof this.startSpectro === 'function') this.startSpectro();
    if (typeof this.startFreq === 'function') this.startFreq();
    if (typeof this.tickTime === 'function') this.tickTime();
    if (typeof this._updateTransportUI === 'function') this._updateTransportUI();
    if (typeof this.renderStaticVisuals === 'function') this.renderStaticVisuals(buf);
  }

  buildLiveChain(buf) {
    // Invoked by play() — delegate to orchestrator if available
    if (window._vipOrch && typeof window._vipOrch.buildLiveChain === 'function') {
      window._vipOrch.buildLiveChain(buf);
      return;
    }
    // Fallback: direct AudioContext source node
    if (!this.ctx || typeof this.ctx.createBufferSource !== 'function') return;
    this.teardownChain();
    const p = window.VIP_PARAMS || {};
    const outGainDb = p.outGain ?? 0;
    const widthLinear = (p.outWidth ?? 100) / 100;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = numFromInput(this.dom && this.dom.tpSpeed, 1);
    const outGainNode = this.ctx.createGain();
    outGainNode.gain.value = Math.pow(10, outGainDb / 20);
    this._outGainNode = outGainNode;
    if (buf.numberOfChannels >= 2 && this.ctx.createChannelSplitter && this.ctx.createChannelMerger) {
      const splitter = this.ctx.createChannelSplitter(2);
      const merger = this.ctx.createChannelMerger(2);
      const mGain = (1 + widthLinear) / 2;
      const sGain = (1 - widthLinear) / 2;

      const lMain = this.ctx.createGain();
      const lCross = this.ctx.createGain();
      const rMain = this.ctx.createGain();
      const rCross = this.ctx.createGain();
      lMain.gain.value = mGain;
      lCross.gain.value = sGain;
      rMain.gain.value = mGain;
      rCross.gain.value = sGain;

      src.connect(splitter);
      splitter.connect(lMain, 0);
      splitter.connect(lCross, 1);
      splitter.connect(rMain, 1);
      splitter.connect(rCross, 0);
      lMain.connect(merger, 0, 0);
      lCross.connect(merger, 0, 0);
      rMain.connect(merger, 0, 1);
      rCross.connect(merger, 0, 1);
      merger.connect(outGainNode);
    } else {
      src.connect(outGainNode);
    }
    if (this.ctx.destination) outGainNode.connect(this.ctx.destination);
    src.start(0, this.playOffset || 0);
    src.onended = () => {
      this.isPlaying = false;
      this.playOffset = 0;
      if (typeof this._updateTransportUI === 'function') this._updateTransportUI();
    };
    this.currentSource = src;
  }

  pause() {
    if (!this.isPlaying) return;
    const speed = numFromInput(this.dom.tpSpeed, 1);
    this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    this.teardownChain();
    if (typeof this.stopSpectro === 'function') this.stopSpectro();
    if (this.isVideo && this.dom.videoPlayer) this.dom.videoPlayer.pause();
    this.isPlaying = false;
  }

  stop() {
    this.teardownChain();
    this.isPlaying = false;
    this.playOffset = 0;
    if (typeof this.stopSpectro === 'function') this.stopSpectro();
    if (this.isVideo && this.dom && this.dom.videoPlayer) {
      this.dom.videoPlayer.pause();
      this.dom.videoPlayer.currentTime = 0;
    }
    if (this.dom && this.dom.tpCur) this.dom.tpCur.textContent = this.fmtDur(0);
    if (this.dom && this.dom.tpSeek) this.dom.tpSeek.value = 0;
    if (typeof this._updateTransportUI === 'function') this._updateTransportUI();
  }

  teardownChain() {
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch (_) {}
      try { this.currentSource.disconnect(); } catch (_) {}
      this.currentSource = null;
    }
    if (this._outGainNode) {
      try { this._outGainNode.disconnect(); } catch (_) {}
    }
    this._outGainNode = null;
  }

  async togglePlayback() {
    this.ensureCtx();
    if (this.isPlaying) {
      this.pause();
      return;
    }
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch (_) {}
      try { this.currentSource.disconnect(); } catch (_) {}
      this.currentSource = null;
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    this.play();
  }

  seekDelta(delta) {
    const buf = this.inputBuffer || this.origBuffer;
    if (!buf) return;
    const speed = numFromInput(this.dom.tpSpeed, 1);
    if (this.isPlaying) {
      this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    }
    this.playOffset = Math.max(0, Math.min(buf.duration, this.playOffset + delta));
    if (this.dom.tpCur) this.dom.tpCur.textContent = this.fmtDur(this.playOffset);
    if (this.dom.tpSeek) this.dom.tpSeek.value = (this.playOffset / buf.duration) * 1000;
    if (this.isPlaying) this.play();
  }

  seekTo(frac) {
    const buf = this.inputBuffer || this.origBuffer;
    if (!buf) return;
    const speed = numFromInput(this.dom.tpSpeed, 1) || 1;
    if (this.isPlaying) {
      this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    }
    this.playOffset = frac * buf.duration;
    if (this.isPlaying) {
      this.play();
    } else {
      if (this.dom.tpCur) this.dom.tpCur.textContent = this.fmtDur(this.playOffset);
      if (this.dom.tpSeek) this.dom.tpSeek.value = frac * 1000;
    }
  }

  toggleAB() {
    const buf = this.outputBuffer || this.procBuffer;
    if (!buf) return;
    const speed = numFromInput(this.dom.tpSpeed, 1);
    if (this.isPlaying) {
      this.playOffset += (this.ctx.currentTime - this.playStartTime) * speed;
    }
    this.abMode = this.abMode === 'original' ? 'processed' : 'original';
    if (this.dom.tpAB) this.dom.tpAB.classList.toggle('active', this.abMode === 'processed');
    // PATCHED BY vip-fixes.js — consider merging
    if (this.dom.tpABLabel) this.dom.tpABLabel.textContent = this.abMode === 'processed' ? 'Processed' : 'Original';
    if (this.isPlaying) this.play();
  }

  _setScrubPos(frac) {
    if (this.dom && this.dom.tpSeek) this.dom.tpSeek.value = frac * 1000;
  }

  // ── Bypass ────────────────────────────────────────────────────────────────
  setBypass(on) {
    if (this.sharedParams) this.sharedParams[0] = on ? 1 : 0;
    const workletNode = window._vipOrch && window._vipOrch.workletNode;
    if (workletNode) workletNode.port.postMessage({ type: 'bypass', enabled: on });
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────
  startDiagnostics() {
    if (window._vipOrch && typeof window._vipOrch.startDiagnostics === 'function') {
      window._vipOrch.startDiagnostics();
    }
  }

  stopDiagnostics() {
    if (window._vipOrch && typeof window._vipOrch.stopDiagnostics === 'function') {
      window._vipOrch.stopDiagnostics();
    }
  }

  startSpectro() {
    if (window._vipOrch && typeof window._vipOrch.startSpectro === 'function') {
      window._vipOrch.startSpectro();
    }
  }

  stopSpectro() {
    if (window._vipOrch && typeof window._vipOrch.stopSpectro === 'function') {
      window._vipOrch.stopSpectro();
    }
  }

  startFreq() {
    if (window._vipOrch && typeof window._vipOrch.startFreq === 'function') {
      window._vipOrch.startFreq();
    }
  }

  tickTime() {
    if (window._vipOrch && typeof window._vipOrch.tickTime === 'function') {
      window._vipOrch.tickTime();
    }
  }

  // ── Notifications / Toast ─────────────────────────────────────────────────
  showNotification(msg, type = 'info', duration = 4000) {
    const region = document.getElementById('toastRegion');
    if (!region) return () => {};

    // Cap at 4 stacked toasts
    while (region.children.length >= 4) {
      if (region.firstChild) region.removeChild(region.firstChild);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    if (type === 'error') toast.setAttribute('role', 'alert');
    const msgNode = document.createElement('span');
    msgNode.textContent = msg;
    toast.appendChild(msgNode);
    region.appendChild(toast);

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      setTimeout(() => {
        try { region.removeChild(toast); } catch (_) {}
      }, 220);
    };

    if (duration > 0) {
      setTimeout(dismiss, duration);
    }

    return dismiss;
  }

  _showToast(msg, type = 'info', duration = 4000) {
    return this.showNotification(msg, type, duration);
  }

  // ── Forensic audit ────────────────────────────────────────────────────────
  async addAuditEntry(buf, stageName) {
    if (!buf) return;
    try {
      const channelData = buf.getChannelData ? buf.getChannelData(0) : buf;
      const hash = await crypto.subtle.digest('SHA-256', channelData.buffer);
      const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
      this.forensicLog.push({ stage: stageName, hash: hashHex, ts: Date.now() });
    } catch (err) {
      structuredLog('warn', '[VIP] addAuditEntry failed', { err: err.message });
    }
  }

  downloadAuditLog() {
    if (!this.forensicLog || this.forensicLog.length === 0) {
      this.showNotification('No forensic entries to download.', 'info');
      return;
    }
    const content = JSON.stringify(this.forensicLog, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vip-forensic-audit-' + Date.now() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // ── Meter / pipeline UI ───────────────────────────────────────────────────
  _updateMeters(peak, rms) {
    const fmt = v => (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB';
    this._setHeaderStat('hPeak', fmt(peak != null ? peak : -60));
    this._setHeaderStat('hRMS', fmt(rms != null ? rms : -60));
    const vuIn = document.querySelector('.vu-meter:nth-child(1)');
    const vuOut = document.querySelector('.vu-meter:nth-child(2)');
    const toLevel = v => Math.max(0, ((v + 60) / 60) * 100).toFixed(1) + '%';
    if (vuIn) vuIn.style.setProperty('--vu-level', toLevel(rms != null ? rms : -60));
    if (vuOut) vuOut.style.setProperty('--vu-level', toLevel(peak != null ? peak : -60));
  }

  _setPipeProgress(pct, label) {
    this.updatePipelineProgress(Math.round((pct / 100) * 32), label, pct);
  }

  _setHeaderStat(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  _updateProcessButtonsState() {
    const hasBuf = Boolean(this.inputBuffer || this.origBuffer);
    const ready = this._ctxReady || this._workletReady || this._dspOnlyMode;
    const canProcess = hasBuf;
    if (this.dom.processBtn) this.dom.processBtn.disabled = !canProcess;
    if (this.dom.mobileProcessBtn) this.dom.mobileProcessBtn.disabled = !canProcess;
  }

  _updateTransportUI() {
    const buf = this.inputBuffer || this.origBuffer;
    const dur = buf ? buf.duration : 0;
    if (this.dom.tpDur) this.dom.tpDur.textContent = fmtTime(dur);
    const enabled = Boolean(buf);
    [this.dom.tpPlay, this.dom.tpPause, this.dom.tpStop, this.dom.tpRew,
     this.dom.tpFwd, this.dom.tpSeek, this.dom.tpAB].forEach(b => {
      if (b) b.disabled = !enabled;
    });
  }

  // ── Pure utility methods (also used as instance methods) ──────────────────

  calcRMS(d) {
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    const r = Math.sqrt(s / d.length);
    return r > 0 ? 20 * Math.log10(r) : -96;
  }

  calcPeak(d) {
    let p = 0;
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > p) p = a;
    }
    return p > 0 ? 20 * Math.log10(p) : -96;
  }

  fmtDur(s) {
    const m = Math.floor(s / 60);
    const sc = Math.floor(s % 60);
    return m + ':' + String(sc).padStart(2, '0');
  }

  makeHarm(amt, ord) {
    const n = 44100;
    const c = new Float32Array(n);
    const k = amt * (ord || 3) * 2 + 1;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      c[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    return c;
  }

  encWav(buf) {
    const nCh = buf.numberOfChannels;
    const sr = buf.sampleRate;
    const dL = buf.length * nCh * 2;
    const a = new ArrayBuffer(44 + dL);
    const v = new DataView(a);
    const ws = (o, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
    };
    ws(0, 'RIFF');
    v.setUint32(4, 36 + dL, true);
    ws(8, 'WAVE');
    ws(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, nCh, true);
    v.setUint32(24, sr, true);
    v.setUint32(28, sr * nCh * 2, true);
    v.setUint16(32, nCh * 2, true);
    v.setUint16(34, 16, true);
    ws(36, 'data');
    v.setUint32(40, dL, true);
    let off = 44;
    const chans = [];
    for (let ch = 0; ch < nCh; ch++) chans.push(buf.getChannelData(ch));
    for (let i = 0; i < buf.length; i++) {
      for (let ch = 0; ch < nCh; ch++) {
        let s = chans[ch][i];
        s = Math.max(-1, Math.min(1, s));
        v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        off += 2;
      }
    }
    return a;
  }

  estVoices(buf) {
    const d = buf.getChannelData(0);
    const sr = buf.sampleRate;
    const bs = Math.floor(sr * 0.5);
    let act = 0;
    for (let i = 0; i < d.length; i += bs) {
      let r = 0;
      const e = Math.min(i + bs, d.length);
      for (let j = i; j < e; j++) r += d[j] * d[j];
      r = Math.sqrt(r / (e - i));
      if (r > 0.01) act++;
    }
    return act < 3 ? '0-1' : act < 10 ? '1' : '1-2+';
  }

  mixDW(dry, wet, wAmt) {
    const nCh = Math.min(dry.numberOfChannels, wet.numberOfChannels);
    const len = Math.min(dry.length, wet.length);
    const sr = dry.sampleRate;
    const out = this.ctx.createBuffer(nCh, len, sr);
    for (let ch = 0; ch < nCh; ch++) {
      const dryData = dry.getChannelData(ch);
      const wetData = wet.getChannelData(ch);
      const outData = out.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        outData[i] = dryData[i] * (1 - wAmt) + wetData[i] * wAmt;
      }
    }
    return out;
  }

  peakNorm(buf, targetDb = -1) {
    const nCh = buf.numberOfChannels;
    const len = buf.length;
    let pk = 0;
    for (let ch = 0; ch < nCh; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const a = Math.abs(d[i]);
        if (a > pk) pk = a;
      }
    }
    if (pk === 0) return buf;
    const g = Math.pow(10, targetDb / 20) / pk;
    const out = this.ctx.createBuffer(nCh, len, buf.sampleRate);
    for (let ch = 0; ch < nCh; ch++) {
      const inp = buf.getChannelData(ch);
      const outp = out.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        outp[i] = Math.max(-1, Math.min(1, inp[i] * g));
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Module-level utility function exports
// ---------------------------------------------------------------------------
function clampToSliderExport(id, value) { return clampToSlider(id, value); }
function numFromInputExport(el, fallback) { return numFromInput(el, fallback); }

if (typeof window !== 'undefined') {
  window.numFromInput = numFromInput;
  window.clampToSlider = clampToSlider;
}

// ---------------------------------------------------------------------------
// Register on window + CommonJS export
// ---------------------------------------------------------------------------
window.VoiceIsolatePro = VoiceIsolatePro;

if (typeof module !== 'undefined') module.exports = VoiceIsolatePro;

(function _vipBootstrap() {
  if (typeof VoiceIsolatePro === 'undefined') return;
  if (window._vipApp) return;
  // Skip when running outside a real browser (test VMs, new Function sandboxes, CommonJS)
  if (typeof document === 'undefined' || typeof document.readyState !== 'string') return;
  if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') return;

  function _callAuthInit() {
    if (typeof Auth !== 'undefined' && Auth && typeof Auth.init === 'function') {
      Auth.init().catch(function(e) {
        console.warn('[app] Auth.init() failed:', e);
      });
    }
  }

  function boot() {
    if (window._vipApp) return;
    var app = null;
    try {
      app = new VoiceIsolatePro();
      app.init();
      app._initCalled = true;
      window._vipApp = app;
      window.vip = app;
      console.info('[app] VoiceIsolatePro ready via app.js bootstrap');
    } catch (e) {
      console.error('[app] Bootstrap failed:', e);
      window._vipApp = null;
      window.vip = null;
    }
    _callAuthInit();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
