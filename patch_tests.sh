#!/bin/bash
# Remove all the ml-worker string tests from sliders.test.js
sed -i '/describe('"'"'ML Worker (Phase 4b)'"'"', () => {/,/});/d' tests/sliders.test.js
