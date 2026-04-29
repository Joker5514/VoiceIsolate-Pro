# THIS FILE HAS BEEN INTENTIONALLY REPLACED.
#
# DO NOT RESTORE OR USE THIS SCRIPT.
#
# Uploading models to HuggingFace and fetching them at runtime from
# huggingface.co violates two hard architectural constraints:
#
#   1. COEP (Cross-Origin-Embedder-Policy: require-corp) blocks cross-origin
#      fetches that don't respond with Cross-Origin-Resource-Policy: cross-origin.
#      HuggingFace CDN does not reliably send that header. This kills
#      SharedArrayBuffer and therefore the entire AudioWorklet DSP pipeline.
#
#   2. The project's 100% local processing guarantee requires that no audio
#      data or model weights are transferred to or from any external server
#      during a session.
#
# The correct workflow is documented in MODELS.md.
# Use scripts/upload_models_to_vercel_blob.py instead.
#
# See: https://github.com/Joker5514/VoiceIsolate-Pro/blob/main/MODELS.md
