import grpc
import json
import numpy as np

# In a real setup, we would load the NVIDIA active_speaker proto file:
# import nvidia.nim.active_speaker_pb2 as active_speaker_pb2
# import nvidia.nim.active_speaker_pb2_grpc as active_speaker_pb2_grpc

class NimActiveSpeakerClient:
    def __init__(self, host='127.0.0.1', port=8001):
        self.channel = grpc.insecure_channel(f'{host}:{port}')

        # This is a mocked client stub since we lack the actual generated python pb2 from NVIDIA
        # self.stub = active_speaker_pb2_grpc.ActiveSpeakerDetectionServiceStub(self.channel)
        print(f"Initialized mock NIM client connected to {host}:{port}")

    def detect_active_speaker(self, video_path, audio_path):
        print(f"Sending video: {video_path} and audio: {audio_path}")

        # We would construct a proper GRPC message here based on the proto definition
        # request = active_speaker_pb2.DetectActiveSpeakerRequest(
        #     video_data=open(video_path, 'rb').read(),
        #     audio_data=open(audio_path, 'rb').read(),
        #     # MFCC data would be calculated here
        # )
        # return self.stub.DetectActiveSpeaker(request)

        # Mocking a response for demonstration purposes:
        return {
            "frames": [
                {
                    "speaking_score": 0.98,
                    "bounding_box": {"x1": 50, "y1": 50, "x2": 150, "y2": 150},
                    "landmarks": [
                        {"x": 75, "y": 75}, {"x": 125, "y": 75},
                        {"x": 100, "y": 100},
                        {"x": 80, "y": 125}, {"x": 120, "y": 125}
                    ],
                    "adaface_embedding": np.random.randn(512).tolist()
                }
            ]
        }

if __name__ == '__main__':
    client = NimActiveSpeakerClient()
    response = client.detect_active_speaker('sample_face.mp4', 'sample_voice.wav')
    print("NIM Response:", json.dumps(response, indent=2)[:500], "...")
