/**
 * /api/nim — NVIDIA NIM active-speaker detection: NOT AVAILABLE.
 *
 * This route used to answer every request with fabricated results (a fixed
 * 0.95 speaking score, a fixed bounding box and a random 512-D "embedding")
 * from a mock gRPC client, reported as success. There is no NIM provider in
 * this repository, and accepting uploaded audio/video for server-side
 * inference contradicts the product's 100% on-device processing promise
 * (CLAUDE.md §1.1). The route refuses explicitly, before reading any body.
 * Wiring a real provider requires an explicit architecture and privacy
 * decision, not a configuration flag.
 */
import express from 'express';

const router = express.Router();

router.use((_req, res) => {
  res.status(501).json({
    error: 'NIM active-speaker detection is not available.',
    reason: 'VoiceIsolate Pro processes audio on-device; no server-side inference provider is configured.',
  });
});

export default router;
