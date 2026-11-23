# MP4 container fixtures

Generated with ffmpeg (3 s, 64x48 H.264 test pattern + 330 Hz AAC-LC stereo 48 kHz):

```
ffmpeg -f lavfi -i "testsrc2=size=64x48:rate=10" -f lavfi -i "sine=frequency=330:sample_rate=48000,aformat=channel_layouts=stereo" \
  -t 3 -c:v libx264 -preset ultrafast -g 5 -b:v 40k -c:a aac -b:a 48k -ar 48000 progressive.mp4
ffmpeg -i progressive.mp4 -c copy -movflags frag_keyframe+empty_moov+default_base_moof frag-moof-base.mp4
ffmpeg -i progressive.mp4 -c copy -movflags frag_keyframe+empty_moov frag-data-offset.mp4
ffmpeg -i progressive.mp4 -c copy -an video-only.mp4
```

`*.audio-packets.json` is ffprobe's independent demux of the audio stream:
`[byteOffset, size, pts, duration]` per packet (timescale 48000), from
`ffprobe -select_streams a:0 -show_entries packet=pts,duration,size,pos -of json`.
