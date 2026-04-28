@echo off
echo ========================================
echo  VoiceIsolate-Pro Setup Runner
echo ========================================

set REPO=C:\Users\randy\VoiceIsolate-Pro
if not exist "%REPO%" (
    echo Repo not found at %REPO%, searching...
    for /d %%i in (C:\Users\randy\*) do (
        if exist "%%i\.git" echo Found git repo: %%i
    )
    echo.
    echo Please cd into your repo folder and run this script from there.
    pause
    exit /b 1
)

cd /d "%REPO%"
echo Repo found: %REPO%

echo.
echo [1/5] Pulling latest from GitHub...
git pull

echo.
echo [2/5] Installing huggingface_hub...
C:\Python314\python.exe -m pip install huggingface_hub -q

echo.
echo [3/5] Exporting ONNX models (this takes ~10 min)...
C:\Python314\python.exe scripts\export_rnnoise_onnx.py
C:\Python314\python.exe scripts\export_demucs_onnx.py
C:\Python314\python.exe scripts\export_bsrnn_onnx.py

echo.
echo [4/5] Uploading to HuggingFace...
C:\Python314\python.exe scripts\upload_models_to_huggingface.py

echo.
echo [5/5] Validating CDN URLs...
node scripts\validate-onnx-models.js

echo.
echo Triggering CI deploy...
git add -A
git commit --allow-empty -m "chore: trigger CI after model upload"
git push

echo.
echo ========================================
echo  ALL DONE - Check GitHub Actions now!
echo ========================================
pause
