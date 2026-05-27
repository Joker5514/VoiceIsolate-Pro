import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import path from 'path';

// Note: In a real implementation we would load the specific proto files from NVIDIA
// but since we don't have them, we mock the gRPC client structure for the NIM service.

const PROTO_PATH = path.resolve(process.cwd(), 'api-routes/nim/active_speaker.proto');
const NIM_HOST = process.env.NIM_HOST || '127.0.0.1:8001';

// Mocking proto definition for demonstration
const packageDefinition = {
    nvidia: {
        nim: {
            active_speaker: {
                ActiveSpeakerDetectionService: class MockClient {
                    constructor(host, credentials) {
                        this.host = host;
                        console.log(`Initialized Mock gRPC client pointing to ${host}`);
                    }
                    DetectActiveSpeaker(request, callback) {
                        // Mock NIM response:
                        // Returns bounding boxes, speaker detection score, AdaFace embeddings
                        callback(null, {
                            frames: [
                                {
                                    speaking_score: 0.95,
                                    bounding_box: { x1: 10, y1: 10, x2: 100, y2: 100 },
                                    landmarks: [
                                        { x: 30, y: 30 }, { x: 70, y: 30 },
                                        { x: 50, y: 60 },
                                        { x: 40, y: 80 }, { x: 60, y: 80 }
                                    ],
                                    adaface_embedding: Array.from({length: 512}, () => Math.random() * 2 - 1)
                                }
                            ]
                        });
                    }
                }
            }
        }
    }
};

const activeSpeakerProto = packageDefinition.nvidia.nim.active_speaker;

export class NimGrpcClient {
    constructor() {
        this.client = new activeSpeakerProto.ActiveSpeakerDetectionService(
            NIM_HOST,
            grpc.credentials.createInsecure()
        );
    }

    async detectActiveSpeaker(videoBuffer, audioBuffer, mfccFeatures) {
        return new Promise((resolve, reject) => {
            const request = {
                video: videoBuffer,
                audio: audioBuffer,
                mfcc: mfccFeatures
            };

            this.client.DetectActiveSpeaker(request, (err, response) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(response);
                }
            });
        });
    }
}
