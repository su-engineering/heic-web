#!/bin/sh
# Regenerates test/fixtures/generated/.
#
# Requires libheif (heif-enc, heif-convert, heif-info) and ImageMagick.
#   brew install libheif imagemagick
set -eu

OUT=test/fixtures/generated
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

# An unmistakably asymmetric pattern: every corner differs and the wedge points
# one way, so a wrong rotation or a flipped mirror axis is obvious at a glance.
magick -size 480x320 xc:'rgb(30,30,40)' \
  -fill 'rgb(220,60,50)'  -draw 'rectangle 0,0 120,80' \
  -fill 'rgb(60,200,90)'  -draw 'rectangle 360,0 479,80' \
  -fill 'rgb(70,120,240)' -draw 'rectangle 0,240 120,319' \
  -fill 'rgb(240,210,60)' -draw 'circle 420,280 420,250' \
  -fill white -draw 'polygon 200,40 300,160 200,160' \
  -fill 'rgb(180,180,180)' -draw 'rectangle 40,150 90,170' \
  "$TMP/asym.png"

heif-enc -q 92 -o "$OUT/asym-base.heic" "$TMP/asym.png" >/dev/null

# No encoder here writes irot or imir, so they are injected into a real file.
for spec in "irot 90" "irot 180" "irot 270" "imir 0" "imir 1"; do
  kind=$(echo "$spec" | cut -d' ' -f1)
  value=$(echo "$spec" | cut -d' ' -f2)
  node --experimental-strip-types tools/inject-property.ts \
    "$OUT/asym-base.heic" "$OUT/asym-$kind-$value.heic" "$kind" "$value"
done

# An AVIF, which shares the mif1 brand with HEIC: isHeic() must decline it while
# still reporting that it is AV1-coded.
heif-enc -A -q 80 -o "$OUT/sample.avif" "$TMP/asym.png" >/dev/null

# Reference renders, from libheif rather than from this package.
for f in "$OUT"/*.heic; do
  heif-convert -q 100 "$f" "${f%.heic}.ref.png" >/dev/null
done

node --experimental-strip-types tools/make-manifest.ts "$OUT"
