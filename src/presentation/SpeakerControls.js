/**
 * VoiceIsolate Pro — Per-Speaker Controls (Layer 4: Presentation)
 *
 * Renders one card per detected speaker (from diarization) with a volume
 * slider plus Mute and Solo toggles, all wired to PlaybackMixer's
 * per-speaker AudioParam automation.
 *
 * THE CONTRACT (CLAUDE.md §1.1): these controls talk to PlaybackMixer
 * AudioParams ONLY. They never call into MLWorker, never re-trigger
 * inference, never touch model state.
 */
'use strict';

export class SpeakerControls {
  /**
   * @param {import('../pipeline/PlaybackMixer.js').PlaybackMixer} mixer
   * @param {HTMLElement} container  grid the cards render into
   * @param {object} [options]
   * @param {Document} [options.document]  injectable for tests
   */
  constructor(mixer, container, options = {}) {
    if (!mixer) throw new TypeError('[VIP][SpeakerControls] A PlaybackMixer instance is required.');
    if (!container) throw new TypeError('[VIP][SpeakerControls] A container element is required.');
    this.mixer = mixer;
    this.container = container;
    this.doc = options.document || globalThis.document;
  }

  /**
   * Rebuild the cards from the mixer's loaded speaker segments.
   * @param {Array<{speakerId: string, label?: string, talkTime?: number}>} [speakers]
   *        optional summary (from summarizeSpeakers) for labels/talk time;
   *        falls back to the mixer's speaker ids.
   * @returns {number} number of cards rendered
   */
  render(speakers) {
    this.container.textContent = '';
    const summaryById = new Map((speakers || []).map((s) => [s.speakerId, s]));
    const ids = this.mixer.speakerIds();

    if (ids.length === 0) {
      const empty = this.doc.createElement('p');
      empty.className = 'hint speaker-empty';
      empty.textContent = 'No distinct speakers detected in this file.';
      this.container.appendChild(empty);
      return 0;
    }

    for (const id of ids) {
      this.container.appendChild(this._buildCard(id, summaryById.get(id)));
    }
    return ids.length;
  }

  /** Remove all cards (e.g. when a new file is processed). */
  clear() {
    this.container.textContent = '';
  }

  _buildCard(id, summary) {
    const state = this.mixer.getSpeakerState(id) || { volume: 1, muted: false, solo: false };
    const card = this.doc.createElement('div');
    card.className = 'speaker-card';
    card.dataset.speakerId = id;

    const header = this.doc.createElement('div');
    header.className = 'speaker-card-header';
    const swatch = this.doc.createElement('span');
    swatch.className = `speaker-swatch speaker-swatch-${(this.mixer.speakerIds().indexOf(id) % 8) + 1}`;
    const label = this.doc.createElement('span');
    label.className = 'speaker-label';
    label.textContent = summary?.label || `Speaker ${id}`;
    header.append(swatch, label);
    if (summary && Number.isFinite(summary.talkTime)) {
      const talk = this.doc.createElement('span');
      talk.className = 'speaker-talk-time';
      talk.textContent = `${summary.talkTime.toFixed(1)}s`;
      header.appendChild(talk);
    }

    const volRow = this.doc.createElement('div');
    volRow.className = 'speaker-vol-row';
    const vol = this.doc.createElement('input');
    vol.type = 'range';
    vol.min = '0';
    vol.max = '100';
    vol.step = '1';
    vol.value = String(Math.round(state.volume * 100));
    vol.setAttribute('aria-label', `Volume for ${label.textContent}`);
    const volVal = this.doc.createElement('span');
    volVal.className = 'slider-val';
    volVal.textContent = `${vol.value}%`;
    vol.addEventListener('input', () => {
      volVal.textContent = `${vol.value}%`;
      this.mixer.setSpeakerVolume(id, Number(vol.value));
    });
    volRow.append(vol, volVal);

    const actions = this.doc.createElement('div');
    actions.className = 'speaker-actions';
    const muteBtn = this.doc.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'btn btn-toggle speaker-mute-btn';
    const soloBtn = this.doc.createElement('button');
    soloBtn.type = 'button';
    soloBtn.className = 'btn btn-toggle speaker-solo-btn';

    const paint = () => {
      const s = this.mixer.getSpeakerState(id) || state;
      muteBtn.textContent = s.muted ? 'Muted' : 'Mute';
      muteBtn.classList.toggle('active', s.muted);
      muteBtn.setAttribute('aria-pressed', String(s.muted));
      muteBtn.setAttribute('aria-label', `${s.muted ? 'Unmute' : 'Mute'} ${label.textContent}`);
      soloBtn.textContent = s.solo ? 'Soloed' : 'Solo';
      soloBtn.classList.toggle('active', s.solo);
      soloBtn.setAttribute('aria-pressed', String(s.solo));
      soloBtn.setAttribute('aria-label', `Solo ${label.textContent}`);
      card.classList.toggle('speaker-card-muted', s.muted);
    };

    muteBtn.addEventListener('click', () => {
      const s = this.mixer.getSpeakerState(id);
      this.mixer.setSpeakerMuted(id, !(s && s.muted));
      paint();
    });
    soloBtn.addEventListener('click', () => {
      const s = this.mixer.getSpeakerState(id);
      this.mixer.setSpeakerSolo(s && s.solo ? null : id);
      // Solo is exclusive — repaint every card's solo button.
      this.container.querySelectorAll('.speaker-card').forEach((el) => {
        el.dispatchEvent(new Event('vip:repaint'));
      });
    });
    card.addEventListener('vip:repaint', paint);

    actions.append(muteBtn, soloBtn);
    card.append(header, volRow, actions);
    paint();
    return card;
  }
}

export default SpeakerControls;
