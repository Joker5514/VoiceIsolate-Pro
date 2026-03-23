# Qodo DSP safety rules

- gateThreshold must be <= -30 dBFS
- compRatio must be 1-20
- outputGain must be -12 to 6 dB
- compAttack in live path must be <= 20ms
- gateAttack must be <= 10ms
- dryWetMix and denoiseMix must be 0.0 to 1.0
- all preset IDs must be kebab-case
- aggressive-isolation requires denoiseMix >= 0.8
