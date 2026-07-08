/**
 * Shared default ML model chains for landing + engineer surfaces.
 */
'use strict';

/** Fast default — BS-RNN vocal separation only (~4 MB). */
export const DEFAULT_ML_MODEL_IDS = Object.freeze(['bsrnn_vocals']);

/** Optional second-pass denoise chain (user-selected "maximum" modes). */
export const DENOISE_CHAIN_MODEL_IDS = Object.freeze(['bsrnn_vocals', 'rnnoise']);