# VoiceIsolate Pro - Vercel Deployment Guide

## Prerequisites

1. **Vercel Account**: Sign up at https://vercel.com
2. **Vercel CLI**: Already installed (v50.32.2)
3. **GitHub Repository**: Already connected (Joker5514/VoiceIsolate-Pro)
4. **ONNX Models**: Need to be uploaded to Vercel Blob Storage

---

## Step 1: Deploy to Vercel

### Option A: Deploy via CLI (Recommended for first deployment)

```bash
# Login to Vercel (if not already logged in)
vercel login

# Deploy to production
vercel --prod

# Follow the prompts:
# - Set up and deploy? Yes
# - Which scope? Select your account
# - Link to existing project? No (first time) or Yes (subsequent)
# - Project name? VoiceIsolate-Pro
# - Directory? ./ (current directory)
# - Override settings? No
```

### Option B: Deploy via GitHub (Automatic)

The repository is already configured for automatic deployment:
1. Push to `main` branch → Vercel auto-deploys
2. Pull requests → Vercel creates preview deployments
3. Check deployment status at: https://vercel.com/dashboard

---

## Step 2: Upload ONNX Models to Vercel Blob Storage

### 2.1 Install Vercel Blob CLI

```bash
npm install -g @vercel/blob
```

### 2.2 Get Your Vercel Blob Token

1. Go to https://vercel.com/dashboard
2. Select your project: VoiceIsolate-Pro
3. Go to Settings → Environment Variables
4. Create new variable:
   - Name: `BLOB_READ_WRITE_TOKEN`
   - Value: (Generate from Vercel Blob dashboard)
   - Environments: Production, Preview, Development

### 2.3 Upload Models Using Python Script

The project includes `scripts/upload_models_to_vercel_blob.py`:

```bash
# Set environment variable
$env:BLOB_READ_WRITE_TOKEN="your-token-here"

# Run upload script
python scripts/upload_models_to_vercel_blob.py

# This will upload:
# - rnnoise_suppressor.onnx (180 KB)
# - demucs_v4_quantized.onnx (83 MB)
# - bsrnn_vocals.onnx (45 MB)
```

### 2.4 Manual Upload via Vercel Dashboard

If you prefer manual upload:

1. Go to https://vercel.com/dashboard
2. Select VoiceIsolate-Pro project
3. Go to Storage → Blob
4. Click "Upload" for each model file:
   - `public/app/models/rnnoise_suppressor.onnx`
   - `public/app/models/demucs_v4_quantized.onnx`
   - `public/app/models/bsrnn_vocals.onnx`

5. Copy the Blob URL for each file (format: `https://[hash].public.blob.vercel-storage.com/[filename]`)

---

## Step 3: Configure Model Path Rewrites

### 3.1 Update vercel.json

Add rewrites for each model to point to Vercel Blob URLs:

```json
{
  "rewrites": [
    {
      "source": "/app/models/rnnoise_suppressor.onnx",
      "destination": "https://[your-blob-url]/rnnoise_suppressor.onnx"
    },
    {
      "source": "/app/models/demucs_v4_quantized.onnx",
      "destination": "https://[your-blob-url]/demucs_v4_quantized.onnx"
    },
    {
      "source": "/app/models/bsrnn_vocals.onnx",
      "destination": "https://[your-blob-url]/bsrnn_vocals.onnx"
    }
  ]
}
```

**Note:** Replace `[your-blob-url]` with actual Blob URLs from Step 2.4

### 3.2 Alternative: Use Environment Variables

For better security and flexibility:

1. Add environment variables in Vercel Dashboard:
   ```
   BLOB_URL_RNNOISE=https://[hash].public.blob.vercel-storage.com/rnnoise_suppressor.onnx
   BLOB_URL_DEMUCS=https://[hash].public.blob.vercel-storage.com/demucs_v4_quantized.onnx
   BLOB_URL_BSRNN=https://[hash].public.blob.vercel-storage.com/bsrnn_vocals.onnx
   ```

2. Update `vercel.json` to use environment variables (requires serverless function)

---

## Step 4: Configure Environment Variables

Set these in Vercel Dashboard → Settings → Environment Variables:

### Required for Production:
```
LICENSE_JWT_SECRET=<generate-with-crypto.randomBytes(64).toString('hex')>
NODE_ENV=production
```

### Optional (for monetization):
```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_ANNUAL=price_...
STRIPE_PRICE_STUDIO_MONTHLY=price_...
STRIPE_PRICE_STUDIO_ANNUAL=price_...
```

### Optional (for mobile):
```
RC_API_KEY_ANDROID=rcb_android_...
RC_API_KEY_IOS=rcb_ios_...
```

---

## Step 5: Test the Deployment

### 5.1 Test Model Download Fallback

1. Open your deployed app: `https://your-project.vercel.app/app/`
2. Open browser DevTools → Console
3. Watch for model download messages
4. The Model Status UI should appear showing:
   - ⬇️ Downloading from Vercel Blob (if configured)
   - 🔄 Fallback to HuggingFace (if Vercel fails)
   - ✅ Complete (when cached)

### 5.2 Test Audio Processing

1. Drop an audio file (MP3, WAV, etc.)
2. Click "Process"
3. Verify:
   - Models download if not cached
   - Progress bars show real-time status
   - Processing completes successfully
   - Output audio plays correctly

### 5.3 Test Fallback System

To test the fallback:
1. Temporarily remove Vercel Blob rewrites from `vercel.json`
2. Redeploy
3. Clear browser cache
4. Reload app
5. Should see: "⚠️ Primary source failed, using fallback CDN"
6. Models should download from HuggingFace

---

## Step 6: Monitor and Optimize

### 6.1 Check Deployment Logs

```bash
# View recent deployments
vercel ls

# View logs for specific deployment
vercel logs [deployment-url]
```

### 6.2 Monitor Blob Storage Usage

1. Go to Vercel Dashboard → Storage → Blob
2. Check:
   - Total storage used
   - Bandwidth usage
   - Request count

### 6.3 Optimize Model Delivery

**Current Setup:**
- Vercel Blob (primary) → Fast, same-origin
- HuggingFace CDN (fallback) → Reliable, cross-origin
- Browser Cache → Instant after first load

**Optimization Tips:**
1. Enable Vercel Edge Caching for models
2. Use Vercel Edge Functions for dynamic model routing
3. Implement progressive model loading (load smaller models first)
4. Add service worker caching for offline support

---

## Troubleshooting

### Issue: Models fail to download from Vercel Blob

**Solution:**
1. Check Blob URLs are correct in `vercel.json`
2. Verify CORS headers allow cross-origin requests
3. Check Vercel Blob storage quota
4. Fallback to HuggingFace should work automatically

### Issue: "COEP/COOP" errors in console

**Solution:**
1. Verify `vercel.json` headers are correct
2. Ensure all resources are same-origin or have CORS headers
3. Check CSP policy allows required sources

### Issue: Models download but processing fails

**Solution:**
1. Check browser console for ONNX Runtime errors
2. Verify model files are not corrupted
3. Test with smaller audio files first
4. Check WebGPU/WASM support in browser

### Issue: Deployment fails

**Solution:**
1. Check build logs: `vercel logs`
2. Verify `package.json` scripts are correct
3. Ensure all dependencies are in `package.json`
4. Check Node.js version compatibility (>=20.0.0)

---

## Quick Reference Commands

```bash
# Deploy to production
vercel --prod

# Deploy preview
vercel

# View logs
vercel logs

# List deployments
vercel ls

# Remove deployment
vercel rm [deployment-url]

# Set environment variable
vercel env add LICENSE_JWT_SECRET

# Pull environment variables locally
vercel env pull .env.local
```

---

## Current Deployment Status

- **Repository:** https://github.com/Joker5514/VoiceIsolate-Pro
- **Branch:** main
- **Latest Commit:** 2fa9f47 (ML model status UI)
- **Vercel CLI:** v50.32.2 ✅
- **GitHub Integration:** Ready ✅
- **Model Fallback:** Configured ✅
- **Status UI:** Implemented ✅

## Next Steps

1. ✅ Run `vercel --prod` to deploy
2. ⏳ Upload models to Vercel Blob
3. ⏳ Configure model path rewrites
4. ⏳ Test model downloads
5. ⏳ Verify fallback system works

---

## Support

- **Vercel Docs:** https://vercel.com/docs
- **Vercel Blob Docs:** https://vercel.com/docs/storage/vercel-blob
- **Project Issues:** https://github.com/Joker5514/VoiceIsolate-Pro/issues