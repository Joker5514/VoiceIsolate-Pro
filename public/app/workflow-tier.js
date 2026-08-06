/**
 * Workflow tier routing — Creator Pro / Studio / Forensic.
 * Controls hero picker, default presets, and engineer panel visibility.
 */

export const WORKFLOW_TIERS = Object.freeze({
  creator: {
    id: 'creator',
    label: 'Creator Pro',
    short: 'Creator',
    tagline: 'Fast clean voice — one tap to share-ready audio',
    statusIdle: 'Creator Pro — upload audio for one-tap clean voice',
    defaultPreset: 'Voice Clarity',
    presets: ['Voice Clarity', 'Podcast Clean', 'Whisper Boost'],
    groups: ['gate', 'nr', 'out'],
    showPresetGrid: false,
    showPresetSelect: false,
    showScenePicker: false,
    showSearch: false,
    showWhisperHunter: true,
    showSaveCustom: false,
  },
  studio: {
    id: 'studio',
    label: 'Studio',
    short: 'Studio',
    tagline: 'Scene presets with guided engineer controls',
    statusIdle: 'Studio — pick a scene preset, tune lightly, then process',
    defaultPreset: 'Podcast Clean',
    presets: [
      'Podcast Clean', 'Phone/Radio',
      'Whisper Boost', 'Voice Clarity', 'Stadium Crowd', 'Surveillance',
    ],
    groups: ['gate', 'nr', 'eq', 'dyn', 'sep', 'out', 'extreme'],
    showPresetGrid: true,
    showPresetSelect: true,
    showScenePicker: true,
    showSearch: true,
    showWhisperHunter: true,
    showSaveCustom: true,
  },
  forensic: {
    id: 'forensic',
    label: 'Forensic',
    short: 'Forensic',
    tagline: 'Maximum intelligibility — full engineer panel',
    statusIdle: 'Forensic — tune for evidence-grade speech recovery',
    defaultPreset: 'Forensic Extract',
    presets: null,
    groups: null,
    showPresetGrid: true,
    showPresetSelect: true,
    showScenePicker: false,
    showSearch: true,
    showWhisperHunter: true,
    showSaveCustom: true,
  },
});

export const STUDIO_SCENES = Object.freeze([
  { id: 'podcast', label: 'Podcast', preset: 'Podcast Clean' },
  { id: 'film', label: 'Film', preset: 'Voice Clarity' },
  { id: 'interview', label: 'Interview', preset: 'Voice Clarity' },
  { id: 'broadcast', label: 'Broadcast', preset: 'Podcast Clean' },
  { id: 'restoration', label: 'Restoration', preset: 'Surveillance' },
  { id: 'custom', label: 'Custom', preset: null },
]);

const STORAGE_KEY = 'vip-workflow-tier';
const GROUP_SECTIONS = [
  { groups: ['gate', 'nr'], match: (el) => el.querySelector('#group-noise-reduction') },
  { groups: ['eq'], match: (el) => el.querySelector('#group-eq') },
  { groups: ['dyn'], match: (el) => el.querySelector('#group-dynamics') },
  { groups: ['spec'], match: (el) => el.querySelector('#group-spectral') },
  { groups: ['adv'], match: (el) => el.querySelector('#group-advanced') },
  { groups: ['out'], match: (el) => el.querySelector('#group-output') },
  { groups: ['sep'], match: (el) => el.querySelector('#group-separation') },
  { groups: ['extreme'], match: (el) => el.id === 'tab-extreme-group' },
];

function $(id) { return document.getElementById(id); }

function resolveTierId(raw) {
  const id = String(raw || '').toLowerCase();
  if (id === 'creator' || id === 'creator-pro' || id === 'pro') return 'creator';
  if (id === 'studio') return 'studio';
  if (id === 'forensic') return 'forensic';
  return null;
}

function readInitialTier() {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = resolveTierId(params.get('tier'));
    if (fromUrl) return fromUrl;
  } catch { /* ignore */ }
  try {
    const stored = resolveTierId(localStorage.getItem(STORAGE_KEY));
    if (stored) return stored;
  } catch { /* ignore */ }
  return 'studio';
}

const WorkflowTier = (() => {
  let appRef = null;
  let currentTier = 'studio';

  function getConfig(tierId = currentTier) {
    return WORKFLOW_TIERS[tierId] || WORKFLOW_TIERS.studio;
  }

  function setHeroCopy(tier) {
    const tagline = $('heroTagline');
    const status = $('heroStatus');
    const hero = $('vipHero');
    if (tagline) tagline.textContent = tier.tagline;
    if (hero) hero.dataset.workflowTier = tier.id;
    if (status && hero?.dataset.uiState === 'idle') {
      status.textContent = tier.statusIdle;
    }
  }

  function filterPresetOptions(tier) {
    const sel = $('presetSel');
    if (!sel) return;
    const allowed = tier.presets;
    for (const opt of sel.options) {
      const show = !allowed || allowed.includes(opt.value || opt.textContent);
      opt.hidden = !show;
      opt.disabled = !show;
    }
    if (tier.showPresetSelect && tier.defaultPreset) {
      const has = [...sel.options].some((o) => !o.hidden && (o.value === tier.defaultPreset || o.textContent === tier.defaultPreset));
      if (has) sel.value = tier.defaultPreset;
    }
  }

  function filterPresetGrid(tier) {
    document.querySelectorAll('.presets-grid .btn-preset[data-preset]').forEach((btn) => {
      const name = btn.dataset.preset;
      const show = tier.showPresetGrid && (!tier.presets || tier.presets.includes(name));
      btn.hidden = !show;
      btn.style.display = show ? '' : 'none';
    });
  }

  function applyPanelVisibility(tier) {
    const allowed = tier.groups;
    const showAll = !allowed;
    document.querySelectorAll('.slider-group').forEach((section) => {
      const meta = GROUP_SECTIONS.find((g) => g.match(section));
      if (!meta) return;
      const visible = showAll || meta.groups.some((g) => allowed.includes(g));
      section.hidden = !visible;
      section.style.display = visible ? '' : 'none';
      if (visible && tier.id === 'creator' && meta.groups.includes('gate')) {
        section.classList.add('active');
        const header = section.querySelector('.slider-group-header');
        const content = section.querySelector('.slider-group-content');
        if (header) header.setAttribute('aria-expanded', 'true');
        if (content) content.style.display = '';
      }
    });

    const presetsWrap = document.querySelector('.presets-wrap');
    if (presetsWrap) presetsWrap.hidden = false;

    const presetGrid = document.querySelector('.presets-grid');
    if (presetGrid) presetGrid.hidden = !tier.showPresetGrid;

    const presetHead = document.querySelector('.presets-head');
    if (presetHead) presetHead.hidden = !tier.showPresetSelect && !tier.showSaveCustom;

    const presetSel = $('presetSel');
    if (presetSel) {
      const label = presetHead?.querySelector('.presets-label');
      if (label) label.hidden = !tier.showPresetSelect;
      presetSel.hidden = !tier.showPresetSelect;
      presetSel.style.display = tier.showPresetSelect ? '' : 'none';
    }

    const saveCustom = $('openPresetModalBtn');
    if (saveCustom) {
      saveCustom.hidden = !tier.showSaveCustom;
      saveCustom.style.display = tier.showSaveCustom ? '' : 'none';
    }

    const searchRow = document.querySelector('.control-search-row');
    if (searchRow) {
      searchRow.hidden = !tier.showSearch;
      searchRow.style.display = tier.showSearch ? '' : 'none';
    }

    const whisperBtn = $('btn-whisper-hunter');
    if (whisperBtn) {
      // Always surface WhisperHunter AI — tiers may still flag showWhisperHunter
      // but we no longer hide the control (was effectively "removed" on Creator/Studio).
      whisperBtn.hidden = false;
      whisperBtn.style.display = '';
      whisperBtn.removeAttribute('hidden');
      whisperBtn.setAttribute('aria-hidden', 'false');
    }

    const sceneRow = $('heroSceneRow');
    if (sceneRow) {
      sceneRow.hidden = !tier.showScenePicker;
      sceneRow.style.display = tier.showScenePicker ? '' : 'none';
    }
  }

  function syncTierPickerUI(tierId) {
    document.querySelectorAll('[data-hero-tier]').forEach((btn) => {
      const active = btn.dataset.heroTier === tierId;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function applyTierPreset(tier, scenePreset) {
    if (!appRef || typeof appRef.applyPreset !== 'function') return;
    const preset = scenePreset || tier.defaultPreset;
    if (preset) appRef.applyPreset(preset);
  }

  function setTier(tierId, { persist = true, applyPreset = true, scenePreset = null } = {}) {
    const resolved = resolveTierId(tierId) || 'studio';
    currentTier = resolved;
    const tier = getConfig(resolved);
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, resolved); } catch { /* ignore */ }
    }
    syncTierPickerUI(resolved);
    setHeroCopy(tier);
    filterPresetOptions(tier);
    filterPresetGrid(tier);
    applyPanelVisibility(tier);
    if (applyPreset) applyTierPreset(tier, scenePreset);
    try {
      window.dispatchEvent(new CustomEvent('vip:tierChanged', { detail: { tier: resolved } }));
    } catch { /* ignore */ }
    return resolved;
  }

  function bindHeroPicker() {
    document.querySelectorAll('[data-hero-tier]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const tierId = btn.dataset.heroTier;
        if (!tierId || tierId === currentTier) return;
        const sceneSel = $('heroSceneSelect');
        let scenePreset = null;
        if (tierId === 'studio' && sceneSel && sceneSel.value !== 'custom') {
          const scene = STUDIO_SCENES.find((s) => s.id === sceneSel.value);
          scenePreset = scene?.preset || null;
        }
        setTier(tierId, { scenePreset });
      });
    });

    $('heroSceneSelect')?.addEventListener('change', (e) => {
      if (currentTier !== 'studio') return;
      const scene = STUDIO_SCENES.find((s) => s.id === e.target.value);
      if (scene?.preset) applyTierPreset(getConfig('studio'), scene.preset);
    });
  }

  return {
    init(app) {
      appRef = app;
      bindHeroPicker();
      const initial = readInitialTier();
      setTier(initial, { persist: false });
      window.addEventListener('vip:fileLoaded', () => {
        const tier = getConfig();
        if (tier.id === 'creator') applyTierPreset(tier);
      });
      window.addEventListener('vip:processingDone', () => {
        if (currentTier === 'creator' && appRef) applyTierPreset(getConfig());
      });
    },
    getTier() { return currentTier; },
    getConfig,
    setTier,
    shouldSkipAutoCalibrate() { return currentTier === 'creator'; },
    getDefaultPreset() { return getConfig().defaultPreset; },
  };
})();

export default WorkflowTier;