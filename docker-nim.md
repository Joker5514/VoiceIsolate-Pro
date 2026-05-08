# NIM Docker Deployment

## Instructions to run NVIDIA Active Speaker Detection NIM

Requirements:
- NVIDIA GPU (Turing, Ampere, Lovelace architecture)
- Docker with NVIDIA runtime (`nvidia-docker2` / NVIDIA Container Toolkit)
- NGC API Key

### Steps:
1. Login to NVIDIA NGC
```bash
docker login nvcr.io
# Username: $oauthtoken
# Password: <YOUR_NGC_API_KEY>
```

2. Run the NIM container
```bash
docker run -it --rm --gpus all \
  -p 8001:8001 \
  -e NGC_API_KEY=<YOUR_NGC_API_KEY> \
  nvcr.io/nvidia/nim/active_speaker_detection:1.0.0
```

*Note: Ensure the target port (8001) matches what VoiceIsolate-Pro connects to in backend configuration.*
