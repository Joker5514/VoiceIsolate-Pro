/**
 * SAM 3 vision sidecar — public API.
 * Optional local video/image segmentation. Not audio separation.
 */
'use strict';

export { isSam3Enabled, isSam31MultiplexEnabled, SAM3_ENV_KEYS } from './featureFlag.js';
export {
  assertLocalModelAsset,
  findForbiddenRemoteHosts,
  ALLOWED_MODEL_PATH_PREFIXES,
} from './policy.js';
export {
  SAM3_LIMITS,
  validateTrack,
  validateFrameResult,
  toWorkletMetadata,
  isValidBox,
} from './types.js';
export { validatePromptCommand, summarizePrompt } from './text_prompt_handler.js';
export { ImageSegmenter, boxIoU } from './image_segmenter.js';
export { VideoTracker, FrameOrderGate } from './video_tracker.js';
export { probeSam3Runtime, probeSam3ModelAsset } from './runtime.js';
export { Sam3Host } from './host.js';
