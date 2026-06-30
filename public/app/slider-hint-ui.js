/**
 * slider-hint-ui.js — Rich visual hint panels for slider rows
 * Direction badges, range meter, toward-chips, and example pills.
 */

const UP_VERBS = new Set(['raise', 'push', 'boost', 'add', 'increase', 'lengthen', 'widen']);
const DOWN_VERBS = new Set(['lower', 'pull', 'cut', 'decrease', 'shorten', 'narrow', 'ease']);

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Infer dominant adjustment direction from hint prose. */
export function inferHintDirection(text) {
  if (!text) return 'both';
  const lower = text.toLowerCase();
  let up = 0;
  let down = 0;
  for (const v of UP_VERBS) {
    if (lower.includes(v)) up += 1;
  }
  for (const v of DOWN_VERBS) {
    if (lower.includes(v)) down += 1;
  }
  if (up > down) return 'up';
  if (down > up) return 'down';
  return 'both';
}

/** Pull "verb toward target" chips for quick scanning. */
export function extractTowardChips(text) {
  if (!text) return [];
  const re = /\b(Raise|Lower|Push|Pull|Cut|Boost|Add|Lengthen|Shorten|Widen|Narrow|Ease)\s+toward\s+([^.;]+)/gi;
  const chips = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const verb = match[1];
    const target = match[2].trim();
    const dir = UP_VERBS.has(verb.toLowerCase()) ? 'up'
      : DOWN_VERBS.has(verb.toLowerCase()) ? 'down' : 'both';
    const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '↕';
    chips.push({ verb, target, dir, arrow, label: `${verb} toward ${target}` });
  }
  return chips.slice(0, 3);
}

function formatHintText(text) {
  const safe = escapeHtml(text);
  return safe.replace(
    /\b(Raise|Lower|Push|Pull|Cut|Boost|Add|Lengthen|Shorten|Widen|Narrow|Ease)\s+toward\s+([^.;]+)/gi,
    '<mark class="hint-toward"><strong>$1</strong> toward <em>$2</em></mark>',
  );
}

function directionLabel(dir) {
  if (dir === 'up') return '↑ Raise';
  if (dir === 'down') return '↓ Lower';
  return '↕ Adjust';
}

/**
 * Build a rich hint panel DOM node.
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.text
 * @param {number} [opts.min]
 * @param {number} [opts.max]
 * @param {number} [opts.value]
 * @param {string} [opts.unit]
 * @param {Array<{label:string,value:number}>} [opts.examples]
 * @param {(value:number)=>void} [opts.onApplyExample]
 */
export function buildHintPanel(opts) {
  const {
    id, text, min, max, value, unit = '', examples = [], onApplyExample,
  } = opts;

  const panel = document.createElement('div');
  panel.className = 'slider-hint';
  if (id) panel.id = id;

  const aids = document.createElement('div');
  aids.className = 'hint-aids-row';

  const dir = inferHintDirection(text);
  const badge = document.createElement('span');
  badge.className = `hint-dir-badge hint-dir-${dir}`;
  badge.setAttribute('aria-hidden', 'true');
  badge.textContent = directionLabel(dir);
  aids.appendChild(badge);

  if (Number.isFinite(min) && Number.isFinite(max)) {
    const pct = max > min && Number.isFinite(value)
      ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100))
      : 50;
    const meter = document.createElement('div');
    meter.className = 'hint-range-meter';
    meter.setAttribute('role', 'img');
    meter.setAttribute('aria-label', `Range ${min}${unit} to ${max}${unit}, current ${value}${unit}`);
    meter.innerHTML = [
      `<span class="hint-range-lo">${min}${unit}</span>`,
      `<span class="hint-range-track"><i class="hint-range-thumb" style="left:${pct.toFixed(1)}%"></i></span>`,
      `<span class="hint-range-hi">${max}${unit}</span>`,
    ].join('');
    aids.appendChild(meter);
  }

  panel.appendChild(aids);

  const body = document.createElement('p');
  body.className = 'hint-body';
  body.innerHTML = formatHintText(text);
  panel.appendChild(body);

  const chips = extractTowardChips(text);
  if (chips.length) {
    const chipRow = document.createElement('div');
    chipRow.className = 'hint-chips';
    chipRow.setAttribute('aria-label', 'Suggested adjustments');
    chips.forEach((chip) => {
      const el = document.createElement('span');
      el.className = `hint-chip hint-chip-${chip.dir}`;
      el.textContent = `${chip.arrow} ${chip.label}`;
      chipRow.appendChild(el);
    });
    panel.appendChild(chipRow);
  }

  if (examples.length) {
    const exRow = document.createElement('div');
    exRow.className = 'hint-examples';
    exRow.setAttribute('aria-label', 'Quick presets');
    examples.forEach((ex) => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'hint-example-pill';
      pill.textContent = ex.label;
      pill.title = `Apply ${ex.value}${unit}`;
      pill.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof onApplyExample === 'function') onApplyExample(ex.value);
      });
      exRow.appendChild(pill);
    });
    panel.appendChild(exRow);
  }

  return panel;
}

/** Mobile bottom-sheet popover with backdrop; desktop inline popover. */
export function mountInfoPopover(pop, anchorRow) {
  const useSheet = window.matchMedia('(max-width: 768px)').matches;
  if (!useSheet) {
    anchorRow.appendChild(pop);
    return () => pop.remove();
  }

  pop.classList.add('info-popover--sheet');
  const backdrop = document.createElement('div');
  backdrop.className = 'info-popover-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  document.body.appendChild(backdrop);
  document.body.appendChild(pop);

  const teardown = () => {
    pop.remove();
    backdrop.remove();
  };
  backdrop.addEventListener('click', teardown);
  return teardown;
}

export function removeAllInfoPopovers() {
  document.querySelectorAll('.info-popover, .info-popover-backdrop').forEach((el) => el.remove());
}