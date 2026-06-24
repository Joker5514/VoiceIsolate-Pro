# VoiceIsolate Pro - API Documentation

## Overview

The VoiceIsolate Pro API provides programmatic access to voice isolation, audio processing, and enhancement features. The API is RESTful and supports both HTTP and WebSocket protocols for real-time audio streaming.

## Base URL

```
https://api.voiceisolate.pro/v1
```

## Authentication

All API requests require authentication using a Bearer token:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" https://api.voiceisolate.pro/v1/...
```

## Rate Limits

- Free tier: 100 requests/hour
- Pro tier: 1000 requests/hour
- Enterprise: Custom limits

## Audio Processing Endpoints

### Process Audio

POST `/audio/process`

Process an audio file with voice isolation.

**Request:**
```json
{
  "file": "base64_encoded_audio",
  "options": {
    "noise_reduction": true,
    "voice_enhancement": true,
    "output_format": "wav"
  }
}
```

**Response:**
```json
{
  "job_id": "job_123456",
  "status": "processing",
  "estimated_time": 30
}
```

### Get Processing Status

GET `/audio/status/{job_id}`

**Response:**
```json
{
  "job_id": "job_123456",
  "status": "completed",
  "result_url": "https://storage.voiceisolate.pro/results/job_123456.wav"
}
```

### Real-time Processing (WebSocket)

Connect to `wss://ws.voiceisolate.pro/v1/stream`

**Message Format:**
```json
{
  "type": "audio_chunk",
  "data": "base64_encoded_audio",
  "timestamp": 1234567890
}
```

## ML Model Endpoints

### List Available Models

GET `/models`

**Response:**
```json
[
  {
    "id": "voice-isolate-v1",
    "name": "Voice Isolation v1",
    "description": "Real-time voice isolation model",
    "version": "1.0.0"
  }
]
```

### Download Model

GET `/models/{model_id}/download`

## Audio Analysis Endpoints

### Spectrogram Analysis

POST `/audio/spectrogram`

**Response:**
```json
{
  "spectrogram_url": "https://storage.voiceisolate.pro/spectrograms/xyz.png",
  "frequency_data": [...]
}
```

### Voice Activity Detection

POST `/audio/vad`

**Response:**
```json
{
  "voice_segments": [
    {"start": 0.5, "end": 2.3},
    {"start": 3.1, "end": 5.7}
  ]
}
```

## Error Handling

All errors follow the standard format:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Invalid request parameters",
    "details": {}
  }
}
```

### Error Codes

| Code | Description |
|------|-------------|
| `INVALID_REQUEST` | Malformed request |
| `AUTHENTICATION_FAILED` | Invalid API key |
| `RATE_LIMIT_EXCEEDED` | Too many requests |
| `PROCESSING_FAILED` | Audio processing error |
| `RESOURCE_NOT_FOUND` | Job or model not found |

## SDKs

### JavaScript/TypeScript

```bash
npm install @voiceisolate/pro-sdk
```

```typescript
import { VoiceIsolate } from '@voiceisolate/pro-sdk';

const client = new VoiceIsolate('YOUR_API_KEY');
const result = await client.processAudio(audioFile);
```

### Python

```bash
pip install voiceisolate-pro
```

```python
from voiceisolate import VoiceIsolate

client = VoiceIsolate('YOUR_API_KEY')
result = client.process_audio(audio_file)
```

## Support

- API Documentation: https://docs.voiceisolate.pro
- Support Email: api-support@voiceisolate.pro
- GitHub Issues: https://github.com/Joker5514/VoiceIsolate-Pro/issues








































































































































