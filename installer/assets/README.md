# Installer artwork

The welcome and finish pages use a generated studio photograph instead of
procedurally drawn decorations. Intermediate pages use plain native headings.

- `welcome-source.png`: original artwork from the built-in ImageGen tool.
- `welcome.bmp`: the same artwork resized to 656 × 1256 and encoded as a
  24-bit RGB BMP for NSIS. The 4× asset stays sharp at higher display scales.
- `logo-source.png`, `logo.png`, `icon.ico`: existing application identity.
  `make-logo.ps1` only prepares the existing logo and icon; it is not used to
  generate installer decorations or run by the release build.

These are checked-in assets. Packaging does not generate or draw artwork.
The old `generate-assets.ps1` and diamond `header.bmp` have been removed.

## Generation prompt

Generated with the built-in ImageGen tool on 2026-09-23:

> Use case: ads-marketing. Create an actual photographic brand artwork for the ChiselCode Windows software installer, NOT a mockup or screenshot of an installer. Portrait aspect ratio approximately 164:314, ideally 1024x1960. A premium studio macro photograph of one precision polished steel sculpting chisel, its clean beveled cutting edge pointing downward, standing diagonally against a sculpted dark graphite monolith. This is the physical metaphor for carefully shaping code. Deep midnight navy background, restrained electric-blue rim light and a subtle cyan reflection on brushed metal, realistic machining lines, tactile stone surface, fine shallow depth of field. Spacious elegant composition: subject centered around the middle-lower area, top quarter nearly empty dark navy for optional branding, no objects cropped awkwardly. A calm, professional developer-tool identity. Photorealistic luxury product photography with crisp silhouette that stays readable at 164x314 pixels. No text, no letters, no UI, no watermark, no drawn diamond decorations, no neon grids, no circuit diagrams, no people.

Only format conversion and resizing were used to prepare the BMP. No text,
shapes, or decoration were added by code.
