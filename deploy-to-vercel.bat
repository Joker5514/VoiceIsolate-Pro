@echo off
REM VoiceIsolate Pro - Vercel Deployment Script
REM This script handles the complete deployment process

echo ========================================
echo VoiceIsolate Pro - Vercel Deployment
echo ========================================
echo.

REM Check if Vercel CLI is installed
where vercel >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Vercel CLI is not installed!
    echo Install with: npm install -g vercel
    pause
    exit /b 1
)

echo [1/5] Checking Vercel CLI version...
vercel --version
echo.

echo [2/5] Logging in to Vercel...
echo Please follow the browser prompts to authenticate.
vercel login
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Vercel login failed!
    pause
    exit /b 1
)
echo.

echo [3/5] Deploying to Vercel (Production)...
echo This may take several minutes...
vercel --prod --yes
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Deployment failed!
    echo Check the error messages above.
    pause
    exit /b 1
)
echo.

echo [4/5] Deployment successful!
echo.

echo [5/5] Next Steps:
echo ========================================
echo 1. Upload ONNX models to Vercel Blob Storage
echo    - Go to: https://vercel.com/dashboard
echo    - Select: VoiceIsolate-Pro project
echo    - Navigate to: Storage -^> Blob
echo    - Upload models from: public/app/models/
echo.
echo 2. Configure model path rewrites in vercel.json
echo    - Copy Blob URLs from Vercel dashboard
echo    - Update vercel.json with rewrite rules
echo    - Redeploy: vercel --prod --yes
echo.
echo 3. Test the deployment
echo    - Open your Vercel URL
echo    - Check Model Status UI appears
echo    - Test model downloads
echo    - Verify fallback to HuggingFace works
echo.
echo 4. Set environment variables (if needed)
echo    - Go to: Settings -^> Environment Variables
echo    - Add: LICENSE_JWT_SECRET, STRIPE keys, etc.
echo.
echo See DEPLOYMENT_GUIDE.md for detailed instructions.
echo ========================================
echo.
pause

@REM Made with Bob
