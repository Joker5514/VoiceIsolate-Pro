#!/usr/bin/env bash
# Build the F06 decode fixtures used by runtime-contracts-browser-check.cjs:
#   tone440_10s.webm — 10 s, 440 Hz stereo Opus + 4 Mbps VP8 (~5 MB)
#   click2s_6s.webm  — 6 s, 440 Hz + a 0.5 ms click at exactly 2.000 s
# Usage: scripts/make-decode-fixtures.sh OUT_DIR   (requires ffmpeg)
set -euo pipefail
out="${1:?usage: make-decode-fixtures.sh OUT_DIR}"
mkdir -p "$out"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=1280x720:rate=30" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 10 \
  -c:v libvpx -b:v 4M -c:a libopus -b:a 128k -ac 2 "$out/tone440_10s.webm"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=640x360:rate=30" \
  -f lavfi -i "aevalsrc='0.2*sin(2*PI*440*t)+0.8*between(t,2.0,2.0005)':s=48000:d=6" -t 6 \
  -c:v libvpx -b:v 1M -c:a libopus -b:a 192k -ac 1 "$out/click2s_6s.webm"
echo "fixtures written to $out"
