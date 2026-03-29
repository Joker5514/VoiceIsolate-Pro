/**
 * VoiceIsolate Pro — Paywall UI v22
 * Renders pricing cards, upgrade modals, feature gates, and trial banners.
 * Integrates with LicenseManager and Stripe Checkout (via backend redirect).
 */

const Paywall = (() => {
  // ─── Stripe Price IDs (replace with real ones from Stripe Dashboard) ──────────
  const STRIPE_PRICES = {
    PRO_MONTHLY:        'price_pro_monthly_placeholder',
    PRO_ANNUAL:         'price_pro_annual_placeholder',
    STUDIO_MONTHLY:     'price_studio_monthly_placeholder',
    STUDIO_ANNUAL:      'price_studio_annual_placeholder',
    ENTERPRISE_MONTHLY: 'price_enterprise_monthly_placeholder',
  };

  // ─── RevenueCat Product IDs (for mobile in-app purchases) ────────────────────
  const RC_PRODUCTS = {
    PRO_MONTHLY:    'voiceisolate_pro_monthly',
    PRO_ANNUAL:     'voiceisolate_pro_annual',
    STUDIO_MONTHLY: 'voiceisolate_studio_monthly',
    STUDIO_ANNUAL:  'voiceisolate_studio_annual',
  };

  let _modalEl = null;
  let _bannerEl = null;
  let _billingCycle = 'monthly'; // 'monthly' | 'annual'

  // ─── Pricing Card HTML ────────────────────────────────────────────────────────
  function _renderPricingCard(tier, tierDef, isCurrentTier) {
    const isAnnual = _billingCycle === 'annual';
    const price = isAnnual ? Math.round(tierDef.priceAnnual / 12) : tierDef.price;
    const totalAnnual = tierDef.priceAnnual;
    const savingsPercent = tierDef.price > 0
      ? Math.round((1 - (tierDef.priceAnnual / (tierDef.price * 12))) * 100)
      : 0;

    const features = [
      { label: 'File size limit', value: tierDef.limits.fileSizeMB === -1 ? 'Unlimited' : `${tierDef.limits.fileSizeMB} MB`, included: true },
      { label: 'Duration limit', value: tierDef.limits.durationMinutes === -1 ? 'Unlimited' : `${tierDef.limits.durationMinutes} min`, included: true },
      { label: 'Exports per day', value: tierDef.limits.exportsPerDay === -1 ? 'Unlimited' : tierDef.limits.exportsPerDay, included: true },
      { label: 'Full 36-stage pipeline', value: '', included: tierDef.features.mlModels },
      { label: 'AI Voice Isolation', value: '', included: tierDef.features.voiceIsolation },
      { label: 'ML Models (Demucs/BSRNN)', value: '', included: tierDef.features.mlModels },
      { label: 'Forensic Mode + SHA-256', value: '', included: tierDef.features.forensicMode },
      { label: 'Batch Processing', value: tierDef.limits.batchFiles > 0 ? `${tierDef.limits.batchFiles === -1 ? 'Unlimited' : tierDef.limits.batchFiles} files` : '', included: tierDef.features.batchProcessing },
      { label: 'Export MP3 / FLAC', value: '', included: tierDef.features.exportMP3 },
      { label: 'Stem Export', value: '', included: tierDef.features.exportStem },
      { label: 'AI Auto-Tune', value: '', included: tierDef.features.aiAutoTune },
      { label: 'Voice Fingerprinting', value: '', included: tierDef.features.voiceFingerprint },
      { label: 'API Access', value: tierDef.limits.apiCallsPerMonth > 0 ? `${tierDef.limits.apiCallsPerMonth === -1 ? 'Unlimited' : tierDef.limits.apiCallsPerMonth.toLocaleString()} calls/mo` : '', included: tierDef.features.apiAccess },
      { label: 'Cloud Sync', value: '', included: tierDef.features.cloudSync },
      { label: 'White-label', value: '', included: tierDef.features.whiteLabel },
      { label: 'No watermark', value: '', included: !tierDef.features.watermark },
    ];

    const featureRows = features.map(f => `
      <div class="vip-feature-row ${f.included ? 'included' : 'excluded'}">
        <span class="vip-feature-check">${f.included ? '✓' : '✗'}</span>
        <span class="vip-feature-label">${f.label}${f.value ? ` <em>(${f.value})</em>` : ''}</span>
      </div>
    `).join('');

    const badgeHtml = tierDef.badge
      ? `<div class="vip-tier-badge" style="background:${tierDef.color}">${tierDef.badge}</div>`
      : '';

    const ctaHtml = tier === 'FREE'
      ? `<button class="vip-cta vip-cta-free" disabled>Current Plan</button>`
      : isCurrentTier
        ? `<button class="vip-cta vip-cta-current" disabled>✓ Active Plan</button>`
        : tier === 'ENTERPRISE'
          ? `<button class="vip-cta vip-cta-enterprise" onclick="Paywall.contactSales()">Contact Sales</button>`
          : `
            <button class="vip-cta vip-cta-trial" onclick="Paywall.startTrial('${tier}')">Start 14-Day Free Trial</button>
            <button class="vip-cta vip-cta-upgrade" style="background:${tierDef.color}" onclick="Paywall.checkout('${tier}', '${_billingCycle}')">
              Upgrade to ${tierDef.name} — $${price}/mo
            </button>
          `;

    const savingsBadge = isAnnual && savingsPercent > 0
      ? `<span class="vip-savings-badge">Save ${savingsPercent}%</span>`
      : '';

    return `
      <div class="vip-pricing-card ${isCurrentTier ? 'vip-card-current' : ''} ${tierDef.badge ? 'vip-card-featured' : ''}"
           style="--tier-color: ${tierDef.color}">
        ${badgeHtml}
        <div class="vip-tier-header">
          <h3 class="vip-tier-name">${tierDef.name}</h3>
          <div class="vip-tier-price">
            ${tier === 'FREE' ? '<span class="vip-price-amount">Free</span>' : `
              <span class="vip-price-amount">$${price}</span>
              <span class="vip-price-period">/mo</span>
              ${isAnnual ? `<div class="vip-price-annual">$${totalAnnual}/yr ${savingsBadge}</div>` : ''}
            `}
          </div>
        </div>
        <div class="vip-feature-list">${featureRows}</div>
        <div class="vip-cta-group">${ctaHtml}</div>
      </div>
    `;
  }

  // ─── Upgrade Modal ────────────────────────────────────────────────────────────
  function _renderModal() {
    const LM = window.LicenseManager;
    const tiers = LM ? LM.getAllTiers() : {};
    const currentTier = LM ? LM.getTier() : 'FREE';

    const cards = Object.entries(tiers).map(([tier, def]) =>
      _renderPricingCard(tier, def, tier === currentTier)
    ).join('');

    return `
      <div id="vip-paywall-modal" class="vip-modal-overlay" role="dialog" aria-modal="true" aria-label="Upgrade VoiceIsolate Pro">
        <div class="vip-modal-container">
          <button class="vip-modal-close" onclick="Paywall.closeModal()" aria-label="Close">✕</button>
          <div class="vip-modal-header">
            <h2>Upgrade VoiceIsolate Pro</h2>
            <p>Unlock studio-grade audio processing — 100% local, zero cloud inference.</p>
            <div class="vip-billing-toggle">
              <button class="vip-toggle-btn ${_billingCycle === 'monthly' ? 'active' : ''}"
                      onclick="Paywall.setBillingCycle('monthly')">Monthly</button>
              <button class="vip-toggle-btn ${_billingCycle === 'annual' ? 'active' : ''}"
                      onclick="Paywall.setBillingCycle('annual')">Annual <span class="vip-save-tag">Save up to 30%</span></button>
            </div>
          </div>
          <div class="vip-pricing-grid">${cards}</div>
          <div class="vip-modal-footer">
            <p>🔒 Secure checkout via Stripe &nbsp;·&nbsp; Cancel anytime &nbsp;·&nbsp; 30-day money-back guarantee</p>
            <p>Have a license key? <a href="#" onclick="Paywall.showLicenseInput()">Enter it here</a></p>
          </div>
        </div>
      </div>
    `;
  }

  // ─── Feature Gate Banner ──────────────────────────────────────────────────────
  function _renderFeatureGate(featureName, requiredTier) {
    const tierDef = window.LicenseManager?.getAllTiers()[requiredTier];
    const color = tierDef?.color || '#6366f1';
    return `
      <div class="vip-feature-gate" data-feature="${featureName}">
        <div class="vip-gate-icon">🔒</div>
        <div class="vip-gate-content">
          <strong>${featureName}</strong> requires
          <span class="vip-gate-tier" style="color:${color}">${tierDef?.name || requiredTier}</span> or higher.
        </div>
        <button class="vip-gate-btn" style="background:${color}"
                onclick="Paywall.openModal('${requiredTier}')">
          Upgrade to Unlock
        </button>
      </div>
    `;
  }

  // ─── Trial Banner ─────────────────────────────────────────────────────────────
  function _renderTrialBanner(tier, daysRemaining) {
    const tierDef = window.LicenseManager?.getAllTiers()[tier];
    return `
      <div id="vip-trial-banner" class="vip-trial-banner" style="--tier-color:${tierDef?.color || '#6366f1'}">
        <span>🎉 ${tier} Trial — <strong>${daysRemaining} days</strong> remaining</span>
        <button onclick="Paywall.checkout('${tier}', 'monthly')" class="vip-trial-upgrade-btn">
          Subscribe to Keep Access →
        </button>
        <button onclick="document.getElementById('vip-trial-banner').remove()" class="vip-trial-dismiss">✕</button>
      </div>
    `;
  }

  // ─── Paywall CSS ──────────────────────────────────────────────────────────────
  function _injectStyles() {
    if (document.getElementById('vip-paywall-styles')) return;
    const style = document.createElement('style');
    style.id = 'vip-paywall-styles';
    style.textContent = `
      /* ── Modal Overlay ── */
      .vip-modal-overlay {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0,0,0,0.85); backdrop-filter: blur(8px);
        display: flex; align-items: center; justify-content: center;
        padding: 1rem; animation: vip-fade-in 0.2s ease;
      }
      @keyframes vip-fade-in { from { opacity:0; transform:scale(0.95); } to { opacity:1; transform:scale(1); } }

      .vip-modal-container {
        background: #0f0f13; border: 1px solid #2a2a3a;
        border-radius: 1.25rem; max-width: 1100px; width: 100%;
        max-height: 90vh; overflow-y: auto; position: relative;
        padding: 2rem;
      }
      .vip-modal-close {
        position: absolute; top: 1rem; right: 1rem;
        background: #1a1a2e; border: 1px solid #2a2a3a; color: #9ca3af;
        width: 2rem; height: 2rem; border-radius: 50%; cursor: pointer;
        font-size: 0.875rem; display: flex; align-items: center; justify-content: center;
      }
      .vip-modal-close:hover { background: #2a2a3a; color: #fff; }

      /* ── Header ── */
      .vip-modal-header { text-align: center; margin-bottom: 2rem; }
      .vip-modal-header h2 { font-size: 1.75rem; font-weight: 700; color: #fff; margin: 0 0 0.5rem; }
      .vip-modal-header p { color: #9ca3af; margin: 0 0 1.25rem; }

      /* ── Billing Toggle ── */
      .vip-billing-toggle { display: inline-flex; background: #1a1a2e; border-radius: 0.5rem; padding: 0.25rem; gap: 0.25rem; }
      .vip-toggle-btn {
        background: transparent; border: none; color: #9ca3af;
        padding: 0.5rem 1.25rem; border-radius: 0.375rem; cursor: pointer;
        font-size: 0.875rem; transition: all 0.15s;
      }
      .vip-toggle-btn.active { background: #6366f1; color: #fff; }
      .vip-save-tag { background: #10b981; color: #fff; font-size: 0.7rem; padding: 0.1rem 0.4rem; border-radius: 0.25rem; margin-left: 0.4rem; }

      /* ── Pricing Grid ── */
      .vip-pricing-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 1rem; margin-bottom: 1.5rem;
      }
      .vip-pricing-card {
        background: #13131f; border: 1px solid #2a2a3a;
        border-radius: 1rem; padding: 1.5rem; position: relative;
        transition: border-color 0.2s, transform 0.2s;
      }
      .vip-pricing-card:hover { border-color: var(--tier-color); transform: translateY(-2px); }
      .vip-card-featured { border-color: var(--tier-color); box-shadow: 0 0 20px rgba(99,102,241,0.15); }
      .vip-card-current { border-color: #10b981; }

      .vip-tier-badge {
        position: absolute; top: -0.75rem; left: 50%; transform: translateX(-50%);
        font-size: 0.7rem; font-weight: 700; padding: 0.25rem 0.75rem;
        border-radius: 1rem; color: #fff; white-space: nowrap;
      }
      .vip-tier-header { margin-bottom: 1.25rem; }
      .vip-tier-name { font-size: 1.1rem; font-weight: 700; color: #fff; margin: 0 0 0.5rem; }
      .vip-tier-price { display: flex; align-items: baseline; gap: 0.25rem; flex-wrap: wrap; }
      .vip-price-amount { font-size: 2rem; font-weight: 800; color: var(--tier-color); }
      .vip-price-period { color: #6b7280; font-size: 0.875rem; }
      .vip-price-annual { font-size: 0.75rem; color: #6b7280; width: 100%; margin-top: 0.25rem; }
      .vip-savings-badge { background: #10b981; color: #fff; font-size: 0.65rem; padding: 0.1rem 0.35rem; border-radius: 0.25rem; margin-left: 0.3rem; }

      /* ── Feature List ── */
      .vip-feature-list { margin-bottom: 1.5rem; display: flex; flex-direction: column; gap: 0.4rem; }
      .vip-feature-row { display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.8rem; }
      .vip-feature-row.included { color: #d1d5db; }
      .vip-feature-row.excluded { color: #4b5563; }
      .vip-feature-check { font-size: 0.75rem; min-width: 1rem; }
      .vip-feature-row.included .vip-feature-check { color: #10b981; }
      .vip-feature-row.excluded .vip-feature-check { color: #374151; }
      .vip-feature-label em { color: #6b7280; font-style: normal; }

      /* ── CTAs ── */
      .vip-cta-group { display: flex; flex-direction: column; gap: 0.5rem; }
      .vip-cta {
        width: 100%; padding: 0.65rem 1rem; border-radius: 0.5rem;
        font-size: 0.85rem; font-weight: 600; cursor: pointer; border: none;
        transition: opacity 0.15s, transform 0.1s;
      }
      .vip-cta:hover:not(:disabled) { opacity: 0.9; transform: translateY(-1px); }
      .vip-cta:disabled { opacity: 0.5; cursor: default; }
      .vip-cta-free, .vip-cta-current { background: #1a1a2e; color: #6b7280; border: 1px solid #2a2a3a; }
      .vip-cta-trial { background: transparent; color: var(--tier-color); border: 1px solid var(--tier-color); }
      .vip-cta-upgrade { color: #fff; }
      .vip-cta-enterprise { background: #10b981; color: #fff; }

      /* ── Footer ── */
      .vip-modal-footer { text-align: center; color: #6b7280; font-size: 0.8rem; }
      .vip-modal-footer a { color: #6366f1; text-decoration: none; }
      .vip-modal-footer a:hover { text-decoration: underline; }

      /* ── Feature Gate ── */
      .vip-feature-gate {
        display: flex; align-items: center; gap: 0.75rem;
        background: #13131f; border: 1px solid #2a2a3a;
        border-radius: 0.75rem; padding: 0.875rem 1rem;
        margin: 0.5rem 0;
      }
      .vip-gate-icon { font-size: 1.25rem; }
      .vip-gate-content { flex: 1; font-size: 0.85rem; color: #9ca3af; }
      .vip-gate-content strong { color: #fff; }
      .vip-gate-tier { font-weight: 700; }
      .vip-gate-btn {
        padding: 0.4rem 0.875rem; border-radius: 0.375rem; border: none;
        color: #fff; font-size: 0.8rem; font-weight: 600; cursor: pointer;
        white-space: nowrap;
      }
      .vip-gate-btn:hover { opacity: 0.9; }

      /* ── Trial Banner ── */
      .vip-trial-banner {
        display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
        background: linear-gradient(135deg, #1a1a2e, #13131f);
        border-bottom: 2px solid var(--tier-color);
        padding: 0.625rem 1rem; font-size: 0.85rem; color: #d1d5db;
        position: sticky; top: 0; z-index: 100;
      }
      .vip-trial-banner span { flex: 1; }
      .vip-trial-upgrade-btn {
        background: var(--tier-color); color: #fff; border: none;
        padding: 0.4rem 0.875rem; border-radius: 0.375rem;
        font-size: 0.8rem; font-weight: 600; cursor: pointer;
      }
      .vip-trial-dismiss {
        background: transparent; border: none; color: #6b7280;
        cursor: pointer; font-size: 1rem; padding: 0.25rem;
      }

      /* ── License Input ── */
      .vip-license-input-group {
        display: flex; gap: 0.5rem; margin-top: 0.75rem;
      }
      .vip-license-input {
        flex: 1; background: #1a1a2e; border: 1px solid #2a2a3a;
        color: #fff; padding: 0.5rem 0.875rem; border-radius: 0.375rem;
        font-size: 0.875rem; font-family: monospace;
      }
      .vip-license-submit {
        background: #6366f1; color: #fff; border: none;
        padding: 0.5rem 1rem; border-radius: 0.375rem;
        font-size: 0.875rem; font-weight: 600; cursor: pointer;
      }

      /* ── Usage Bar ── */
      .vip-usage-bar-wrap { margin-top: 0.5rem; }
      .vip-usage-label { font-size: 0.75rem; color: #6b7280; display: flex; justify-content: space-between; margin-bottom: 0.25rem; }
      .vip-usage-bar { height: 4px; background: #1a1a2e; border-radius: 2px; overflow: hidden; }
      .vip-usage-fill { height: 100%; border-radius: 2px; transition: width 0.3s; }

      @media (max-width: 600px) {
        .vip-pricing-grid { grid-template-columns: 1fr; }
        .vip-modal-container { padding: 1.25rem; }
      }
    `;
    document.head.appendChild(style);
  }

  // ─── Public API ───────────────────────────────────────────────────────────────
  const PW = {
    /**
     * Open the upgrade modal, optionally highlighting a specific tier.
     */
    openModal(highlightTier = null) {
      _injectStyles();
      if (_modalEl) _modalEl.remove();
      _modalEl = document.createElement('div');
      _modalEl.innerHTML = _renderModal();
      document.body.appendChild(_modalEl);
      document.body.style.overflow = 'hidden';

      // Close on overlay click
      _modalEl.querySelector('.vip-modal-overlay').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) PW.closeModal();
      });

      // Keyboard close
      const keyHandler = (e) => { if (e.key === 'Escape') { PW.closeModal(); document.removeEventListener('keydown', keyHandler); } };
      document.addEventListener('keydown', keyHandler);
    },

    closeModal() {
      if (_modalEl) { _modalEl.remove(); _modalEl = null; }
      document.body.style.overflow = '';
    },

    setBillingCycle(cycle) {
      _billingCycle = cycle;
      if (_modalEl) {
        const grid = _modalEl.querySelector('.vip-pricing-grid');
        const toggle = _modalEl.querySelector('.vip-modal-header');
        if (grid) {
          const LM = window.LicenseManager;
          const tiers = LM ? LM.getAllTiers() : {};
          const currentTier = LM ? LM.getTier() : 'FREE';
          grid.innerHTML = Object.entries(tiers).map(([tier, def]) =>
            _renderPricingCard(tier, def, tier === currentTier)
          ).join('');
        }
        // Update toggle buttons
        _modalEl.querySelectorAll('.vip-toggle-btn').forEach(btn => {
          btn.classList.toggle('active', btn.textContent.toLowerCase().includes(cycle));
        });
      }
    },

    /**
     * Redirect to Stripe Checkout for the given tier and billing cycle.
     * In production, this calls your backend /api/checkout which creates a Stripe session.
     */
    checkout(tier, cycle = 'monthly') {
      const priceKey = `${tier}_${cycle.toUpperCase()}`;
      const priceId = STRIPE_PRICES[priceKey];

      // In production: POST to /api/checkout → get Stripe session URL → redirect
      // For now: show a demo activation
      if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        const confirmed = confirm(
          `[DEMO MODE]\n\nThis would redirect to Stripe Checkout for:\n` +
          `Plan: VoiceIsolate ${tier} (${cycle})\n` +
          `Price ID: ${priceId}\n\n` +
          `Activate a demo license instead?`
        );
        if (confirmed) {
          const LM = window.LicenseManager;
          if (LM) {
            const token = LM._createDemoTokenPublic ? LM._createDemoTokenPublic(tier, 30) : null;
            if (token) {
              const result = LM.activate(token, 'demo@voiceisolatepro.com');
              if (result.success) {
                PW.closeModal();
                PW.showSuccessToast(`${tier} activated! (Demo mode)`);
                window.dispatchEvent(new CustomEvent('vip:tier-changed', { detail: { tier } }));
              }
            }
          }
        }
        return;
      }

      // Production: call backend
      fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId, tier, cycle }),
      })
        .then(r => r.json())
        .then(data => { if (data.url) window.location.href = data.url; })
        .catch(() => alert('Checkout unavailable. Please try again.'));
    },

    /**
     * Start a 14-day free trial.
     */
    startTrial(tier) {
      const LM = window.LicenseManager;
      if (!LM) return;
      const result = LM.activateTrial(tier);
      if (result.success) {
        PW.closeModal();
        PW.showSuccessToast(`${tier} trial started! 14 days free.`);
        window.dispatchEvent(new CustomEvent('vip:tier-changed', { detail: { tier } }));
        PW.showTrialBanner(tier, 14);
      } else {
        alert(result.error || 'Could not start trial.');
      }
    },

    /**
     * Show the license key input form.
     */
    showLicenseInput() {
      const footer = _modalEl?.querySelector('.vip-modal-footer');
      if (!footer) return;
      footer.innerHTML += `
        <div class="vip-license-input-group">
          <input type="text" class="vip-license-input" id="vip-license-key-input"
                 placeholder="Enter license key (e.g. eyJ...)" />
          <button class="vip-license-submit" onclick="Paywall.submitLicenseKey()">Activate</button>
        </div>
      `;
    },

    submitLicenseKey() {
      const input = document.getElementById('vip-license-key-input');
      if (!input) return;
      const token = input.value.trim();
      const LM = window.LicenseManager;
      if (!LM) return;
      const result = LM.activate(token);
      if (result.success) {
        PW.closeModal();
        PW.showSuccessToast(`License activated! Welcome to ${result.tier}.`);
        window.dispatchEvent(new CustomEvent('vip:tier-changed', { detail: { tier: result.tier } }));
      } else {
        input.style.borderColor = '#ef4444';
        input.placeholder = result.error || 'Invalid license key';
      }
    },

    contactSales() {
      window.open('mailto:sales@voiceisolatepro.com?subject=Enterprise%20Inquiry', '_blank');
    },

    /**
     * Show a feature gate overlay on a specific element.
     */
    gateFeature(containerEl, featureName, requiredTier) {
      _injectStyles();
      if (!containerEl) return;
      containerEl.style.position = 'relative';
      const gate = document.createElement('div');
      gate.innerHTML = _renderFeatureGate(featureName, requiredTier);
      gate.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(15,15,19,0.92);border-radius:inherit;z-index:10;';
      containerEl.appendChild(gate);
    },

    /**
     * Show the trial banner at the top of the page.
     */
    showTrialBanner(tier, daysRemaining) {
      _injectStyles();
      if (_bannerEl) _bannerEl.remove();
      _bannerEl = document.createElement('div');
      _bannerEl.innerHTML = _renderTrialBanner(tier, daysRemaining);
      document.body.insertBefore(_bannerEl, document.body.firstChild);
    },

    /**
     * Show a success toast notification.
     */
    showSuccessToast(message) {
      _injectStyles();
      const toast = document.createElement('div');
      toast.style.cssText = `
        position:fixed; bottom:1.5rem; right:1.5rem; z-index:10000;
        background:#10b981; color:#fff; padding:0.75rem 1.25rem;
        border-radius:0.625rem; font-size:0.875rem; font-weight:600;
        box-shadow:0 4px 20px rgba(0,0,0,0.4);
        animation: vip-fade-in 0.2s ease;
      `;
      toast.textContent = `✓ ${message}`;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 4000);
    },

    /**
     * Render the usage bar for the current tier.
     */
    renderUsageBar(containerEl) {
      const LM = window.LicenseManager;
      if (!LM || !containerEl) return;
      const usage = LM.getUsage();
      const pct = usage.exportLimitToday === -1 ? 0
        : Math.min(100, (usage.exportsToday / usage.exportLimitToday) * 100);
      const color = pct > 80 ? '#ef4444' : pct > 50 ? '#f59e0b' : '#10b981';
      containerEl.innerHTML = `
        <div class="vip-usage-bar-wrap">
          <div class="vip-usage-label">
            <span>Exports today</span>
            <span>${usage.exportsToday} / ${usage.exportLimitToday === -1 ? '∞' : usage.exportLimitToday}</span>
          </div>
          <div class="vip-usage-bar">
            <div class="vip-usage-fill" style="width:${pct}%;background:${color}"></div>
          </div>
        </div>
      `;
    },
  };

  // Expose createDemoToken for demo checkout
  if (typeof window !== 'undefined') {
    window.Paywall = PW;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PW;
  }

  return PW;
})();
