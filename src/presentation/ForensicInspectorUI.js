/**
 * VoiceIsolate Pro — Forensic Inspector & Provenance Verifier UI (Layer 4: Presentation)
 *
 * VIP-020: Displays source/output SHA-256 hashes, verification status, model &
 * version pins, manifest digest, effective processing parameters, chronological
 * operation history, timestamps, sidecar JSON inspection/export, and an
 * interactive offline verifier inside `#section-forensic`.
 *
 * Explicitly states that `.viprovenance.json` is local SHA-256 integrity
 * metadata — NOT legal certification, digital signing, trusted timestamping,
 * or chain-of-custody compliance.
 */
'use strict';

import {
  PROVENANCE_VERDICT,
  PROVENANCE_NON_CERTIFICATION_DISCLAIMER,
} from '../core/Provenance.js';
import { downloadBlob } from '../pipeline/ExportManager.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const VERDICT_BADGE = Object.freeze({
  [PROVENANCE_VERDICT.VERIFIED]: { cls: 'ok', text: 'VERIFIED' },
  [PROVENANCE_VERDICT.MISMATCH]: { cls: 'bad', text: 'MISMATCH' },
  [PROVENANCE_VERDICT.MALFORMED_METADATA]: { cls: 'bad', text: 'MALFORMED METADATA' },
  [PROVENANCE_VERDICT.MISSING_SIDECAR]: { cls: 'warn', text: 'MISSING SIDECAR' },
  [PROVENANCE_VERDICT.UNSUPPORTED_SCHEMA]: { cls: 'warn', text: 'UNSUPPORTED SCHEMA' },
});

/**
 * Render pure HTML for the Forensic Provenance Inspector state (testable in Node).
 * @param {ReturnType<import('../pipeline/EngineerProvenanceCoordinator.js').EngineerProvenanceCoordinator['getState']>} state
 * @param {{ paramsOpen?: boolean, jsonOpen?: boolean, verifierOpen?: boolean }} [uiOpts]
 * @returns {string}
 */
export function renderForensicInspectorHtml(state, uiOpts = {}) {
  const source = state?.source || null;
  const lastExport = state?.lastExport || null;
  const record = lastExport?.record || state?.lastVerification?.record || null;
  const verification = state?.lastVerification || null;
  const operations = Array.isArray(state?.operations) ? state.operations : (record?.processing?.operations || []);

  // Source hash display
  const srcHashText = source?.status === 'hashing'
    ? 'Computing SHA-256…'
    : (source?.sha256 || record?.source?.sha256 || 'No source hashed yet');
  const srcMetaText = source
    ? `${source.name} · ${fmtBytes(source.sizeBytes)}${source.mimeType ? ` · ${source.mimeType}` : ''}`
    : (record?.source?.name ? `${record.source.name} · ${fmtBytes(record.source.sizeBytes)}` : 'Import a file to hash original bytes');

  // Output hash display
  const outInfo = record?.export?.output || null;
  const outHashText = outInfo?.sha256 || 'Export processed audio to record output SHA-256';
  const outMetaText = outInfo?.filename
    ? `${outInfo.filename} · ${fmtBytes(outInfo.sizeBytes)} · ${record?.export?.timestamp || ''}`
    : 'No processed export recorded in this session yet';

  // Manifest digest & schema
  const digestText = record?.manifestDigest || '—';
  const schemaText = record ? `${record.schema}@v${record.schemaVersion}` : 'vip-provenance@v1 (pending export)';

  // Model & version pins
  const appInfo = record?.application || null;
  const snapInfo = state?.lastProcessSnapshot || null;
  const modelIds = appInfo?.modelIds || snapInfo?.modelIds || [];
  const modelsList = appInfo?.models || [];
  let modelPinsHtml = '—';
  if (appInfo || snapInfo) {
    if (modelIds.length === 0) {
      modelPinsHtml = '<span>Classical DSP fallback (no neural model weights invoked)</span>';
    } else if (modelsList.length > 0) {
      modelPinsHtml = modelsList.map((m) =>
        `<div><code>${escapeHtml(m.id)}</code> · sha256: <code>${escapeHtml(m.sha256 || 'unpinned')}</code></div>`,
      ).join('');
    } else {
      modelPinsHtml = modelIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(' → ');
    }
  }
  const versionLine = appInfo
    ? `App v${escapeHtml(appInfo.version || 'dev')} · Inference ${escapeHtml(appInfo.inferenceRevision || '—')} · Chain rev ${escapeHtml(appInfo.modelChainRevision || '—')}`
    : 'Recorded automatically on Process & Export';

  // Processing parameters
  const paramsObj = record?.processing?.parameters || snapInfo?.effectiveParams || null;
  const exportOpts = record?.export?.options || null;
  const paramsSummaryText = paramsObj
    ? `${Object.keys(paramsObj).length} calibrated parameters${exportOpts ? ` · dither=${exportOpts.ditherAmt ?? 0}${exportOpts.ditherSeed != null ? ` (seed ${exportOpts.ditherSeed})` : ''}` : ''}`
    : 'Not captured yet (run Process or Export)';
  const paramsJson = paramsObj
    ? JSON.stringify({ exportOptions: exportOpts, parameters: paramsObj }, null, 2)
    : 'null';

  // Operations history
  const opsHtml = operations.length > 0
    ? operations.slice(-25).map((op) => {
      const cls = op.status === 'completed' ? 'ok' : (op.status === 'cancelled' ? 'warn' : 'bad');
      return `<li class="vip-forensic-op">
        <span class="cap-pill ${cls}">${escapeHtml(op.status)}</span>
        <strong>${escapeHtml(op.id)}</strong>
        <span class="vip-forensic-op__ts">${escapeHtml(op.timestamp || '')}</span>
        ${op.detail ? `<span class="vip-forensic-op__detail">${escapeHtml(op.detail)}</span>` : ''}
      </li>`;
    }).join('')
    : '<li class="vip-forensic-empty">No operations recorded yet.</li>';

  // Verification status block
  let verificationHtml = `
    <div class="vip-forensic-verdict" id="forensicVerificationResult" data-verdict="idle" role="status" aria-live="polite">
      <span class="cap-pill opt">Not Verified Yet</span>
      <span class="vip-forensic-verdict__msg">Export processed audio or load a <code>.viprovenance.json</code> sidecar below to verify hashes.</span>
    </div>`;
  if (verification) {
    const meta = VERDICT_BADGE[verification.verdict] || { cls: 'warn', text: String(verification.verdict || 'UNKNOWN').toUpperCase() };
    const badgeCls = verification.verdict === PROVENANCE_VERDICT.VERIFIED && verification.partialByteVerification
      ? 'warn'
      : meta.cls;
    const checks = verification.checks || {};
    const failuresHtml = (verification.failures || []).length > 0
      ? `<ul class="vip-forensic-failures">${verification.failures.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`
      : '';
    verificationHtml = `
      <div class="vip-forensic-verdict" id="forensicVerificationResult" data-verdict="${escapeHtml(verification.verdict)}" role="status" aria-live="polite">
        <div class="vip-forensic-verdict__head">
          <span class="cap-pill ${badgeCls}" data-role="verdict-badge">${escapeHtml(meta.text)}</span>
          <strong>${escapeHtml(verification.label || '')}</strong>
        </div>
        <div class="vip-forensic-checks">
          <span>Schema: <strong>${escapeHtml(checks.schema || 'unverified')}</strong></span>
          <span>Manifest digest: <strong>${escapeHtml(checks.manifestDigest || 'unverified')}</strong></span>
          <span>Source SHA-256: <strong>${escapeHtml(checks.sourceSha256 || 'unverified')}</strong></span>
          <span>Output SHA-256: <strong>${escapeHtml(checks.outputSha256 || 'unverified')}</strong></span>
        </div>
        ${failuresHtml}
        <div class="vip-forensic-verdict__action">${escapeHtml(verification.action || '')}</div>
      </div>`;
  }

  const sidecarJson = lastExport?.record
    ? JSON.stringify(lastExport.record, null, 2)
    : (record ? JSON.stringify(record, null, 2) : '');
  const hasExportSidecar = Boolean(lastExport?.record);

  return `
    <div class="vip-forensic-inspector" data-testid="forensic-inspector">
      <div class="vip-forensic-disclaimer" data-testid="forensic-disclaimer" role="note">
        <strong>Integrity Scope Notice:</strong> ${escapeHtml(state?.disclaimer || PROVENANCE_NON_CERTIFICATION_DISCLAIMER)}
      </div>

      ${verificationHtml}

      <div class="vip-forensic-grid">
        <div class="vip-forensic-field">
          <div class="vip-forensic-field__label">Source File SHA-256</div>
          <div class="vip-forensic-field__sub">${escapeHtml(srcMetaText)}</div>
          <code class="vip-forensic-hash" data-testid="forensic-source-sha256">${escapeHtml(srcHashText)}</code>
        </div>
        <div class="vip-forensic-field">
          <div class="vip-forensic-field__label">Exported Output SHA-256</div>
          <div class="vip-forensic-field__sub">${escapeHtml(outMetaText)}</div>
          <code class="vip-forensic-hash" data-testid="forensic-output-sha256">${escapeHtml(outHashText)}</code>
        </div>
        <div class="vip-forensic-field">
          <div class="vip-forensic-field__label">Manifest Digest (${escapeHtml(schemaText)})</div>
          <code class="vip-forensic-hash" data-testid="forensic-manifest-digest">${escapeHtml(digestText)}</code>
        </div>
        <div class="vip-forensic-field">
          <div class="vip-forensic-field__label">Model &amp; Version Pins</div>
          <div class="vip-forensic-field__sub">${versionLine}</div>
          <div class="vip-forensic-pins" data-testid="forensic-model-pins">${modelPinsHtml}</div>
        </div>
      </div>

      <details class="vip-forensic-details" data-role="params-details"${uiOpts.paramsOpen ? ' open' : ''}>
        <summary>Processing Parameters (${escapeHtml(paramsSummaryText)})</summary>
        <pre class="cap-pre vip-forensic-pre" data-testid="forensic-parameters">${escapeHtml(paramsJson)}</pre>
      </details>

      <div class="vip-forensic-ops-wrap">
        <div class="vip-forensic-field__label">Operation History (${operations.length})</div>
        <ul class="vip-forensic-ops" data-testid="forensic-operation-history">${opsHtml}</ul>
      </div>

      <div class="vip-forensic-actions">
        <button type="button" class="btn btn-xs" id="btnVerifyCurrentProvenance">Verify Session Hashes</button>
        <button type="button" class="btn btn-xs" id="btnDownloadProvenanceSidecar" ${hasExportSidecar ? '' : 'disabled'}>Download .viprovenance.json</button>
      </div>

      <details class="vip-forensic-details" data-role="json-details"${uiOpts.jsonOpen ? ' open' : ''}>
        <summary>Inspect Sidecar JSON${lastExport?.sidecarFilename ? ` (${escapeHtml(lastExport.sidecarFilename)})` : ''}</summary>
        <pre class="cap-pre vip-forensic-pre" data-testid="forensic-sidecar-json">${escapeHtml(sidecarJson || 'Export processed audio to generate .viprovenance.json')}</pre>
      </details>

      <details class="vip-forensic-details" data-role="verifier-details" data-testid="forensic-external-verifier"${uiOpts.verifierOpen ? ' open' : ''}>
        <summary>Verify External Sidecar &amp; Files</summary>
        <div class="vip-forensic-verifier-form">
          <label class="vip-forensic-input-label" for="forensicSidecarInput">1. Sidecar (.viprovenance.json)</label>
          <input type="file" id="forensicSidecarInput" accept=".json,application/json" class="vip-forensic-file-input">
          <label class="vip-forensic-input-label" for="forensicVerifySourceInput">2. Original source media (optional byte check)</label>
          <input type="file" id="forensicVerifySourceInput" class="vip-forensic-file-input">
          <label class="vip-forensic-input-label" for="forensicVerifyOutputInput">3. Exported WAV/MP4 output (optional byte check)</label>
          <input type="file" id="forensicVerifyOutputInput" class="vip-forensic-file-input">
          <button type="button" class="btn btn-xs" id="btnVerifyExternalProvenance">Run Sidecar Verification</button>
        </div>
      </details>
    </div>`;
}

/**
 * Mount the interactive Forensic Provenance Inspector inside a container.
 *
 * @param {HTMLElement|null} container
 * @param {import('../pipeline/EngineerProvenanceCoordinator.js').EngineerProvenanceCoordinator} coordinator
 * @param {{ onNotify?: (msg: string, type?: string) => void }} [opts]
 */
export function mountForensicInspectorUI(container, coordinator, opts = {}) {
  if (!container || !coordinator) {
    return { destroy() {}, render() {} };
  }
  const notify = opts.onNotify || (() => {});

  function syncTopSaveSidecarButton(state) {
    const saveSidecarBtn = typeof document !== 'undefined'
      ? document.getElementById('saveProvenanceBtn')
      : null;
    if (!saveSidecarBtn) return;
    const ready = Boolean(state?.lastExport?.record);
    saveSidecarBtn.disabled = !ready;
  }

  function render(state = coordinator.getState()) {
    const paramsOpen = Boolean(container.querySelector('[data-role="params-details"]')?.open);
    const jsonOpen = Boolean(container.querySelector('[data-role="json-details"]')?.open);
    const verifierOpen = Boolean(container.querySelector('[data-role="verifier-details"]')?.open);

    container.innerHTML = renderForensicInspectorHtml(state, {
      paramsOpen,
      jsonOpen,
      verifierOpen,
    });
    syncTopSaveSidecarButton(state);
    bindControls();
  }

  function bindControls() {
    const verifySessionBtn = container.querySelector('#btnVerifyCurrentProvenance');
    verifySessionBtn?.addEventListener('click', async () => {
      verifySessionBtn.disabled = true;
      try {
        const res = await coordinator.verifyCurrentSession();
        notify(`${res.label}: ${res.action}`, res.ok ? 'info' : 'warn');
      } finally {
        verifySessionBtn.disabled = false;
      }
    });

    const dlBtn = container.querySelector('#btnDownloadProvenanceSidecar');
    dlBtn?.addEventListener('click', async () => {
      const exp = coordinator.getLastExport();
      if (!exp?.sidecarBlob) {
        notify('Export processed audio first to generate a .viprovenance.json sidecar.', 'info');
        return;
      }
      await downloadBlob(exp.sidecarBlob, exp.sidecarFilename);
      notify(`Saved ${exp.sidecarFilename} (local SHA-256 record — not certification or signature)`, 'info');
    });

    const verifyExtBtn = container.querySelector('#btnVerifyExternalProvenance');
    verifyExtBtn?.addEventListener('click', async () => {
      const sidecarFile = container.querySelector('#forensicSidecarInput')?.files?.[0] || null;
      const sourceFile = container.querySelector('#forensicVerifySourceInput')?.files?.[0] || null;
      const outputFile = container.querySelector('#forensicVerifyOutputInput')?.files?.[0] || null;
      verifyExtBtn.disabled = true;
      try {
        const sidecarText = sidecarFile ? await sidecarFile.text() : null;
        const res = await coordinator.verifyExternalSidecar({
          sidecarText,
          sourceBlob: sourceFile,
          outputBlob: outputFile,
        });
        notify(`${res.label}: ${res.action}`, res.ok ? 'info' : 'warn');
      } catch (err) {
        notify(`Verification error: ${err?.message || err}`, 'error');
      } finally {
        verifyExtBtn.disabled = false;
      }
    });
  }

  // Bind optional top-level `#saveProvenanceBtn` in the Engineer `.save-row`
  const topBtn = typeof document !== 'undefined' ? document.getElementById('saveProvenanceBtn') : null;
  const onTopClick = async () => {
    const exp = coordinator.getLastExport();
    if (!exp?.sidecarBlob) {
      notify('Save Processed first to generate a .viprovenance.json integrity record.', 'info');
      return;
    }
    await downloadBlob(exp.sidecarBlob, exp.sidecarFilename);
    notify(`Saved ${exp.sidecarFilename} (local SHA-256 record — not certification or signature)`, 'info');
  };
  topBtn?.addEventListener('click', onTopClick);

  const unsub = coordinator.subscribe((state) => render(state));
  render();

  return {
    render,
    destroy() {
      unsub();
      topBtn?.removeEventListener('click', onTopClick);
    },
  };
}

export default {
  renderForensicInspectorHtml,
  mountForensicInspectorUI,
};
