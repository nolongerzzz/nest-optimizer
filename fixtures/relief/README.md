# relief/ - pictures for the relief generator (`nso_relief.js`)

| file | what | source and licence |
|---|---|---|
| `camera.png` | a real photograph, 512 x 512, 8-bit grey: a man with a camera on a tripod, grass, sky, buildings | scikit-image's sample `camera` image (`skimage/data/camera.png`, scikit-image 0.26.0 wheel), byte for byte. **CC0** by the photographer, Lav Varshney - scikit-image's own docstring: "No copyright restrictions. CC0 by the photographer (Lav Varshney)." |
| `line-drawing-scan.jpg` | a line drawing that has been through a flatbed scanner - **simulated**, 1200 x 900 JPEG, quality 85 | made by `tools/nso_relief_scan_fixture.py` (`npm run relief:scan-fixture`, needs Pillow), deterministic. A cottage, a tree, a sun and a wavy ground line in a pressure-varying pen, on warm paper (~236) under uneven lamp light (+/-9 levels), sensor noise (sigma 3.5), a soft blur, then JPEG. About 2.4% of the pixels are ink. |

Neither existed in the repo before this ticket: `raster-real/` holds Chromium-drawn
strokes and no photographs, and the network here cannot reach Wikimedia, so the
photo came from a PyPI wheel (whose data directory is public-domain and CC0
samples) and the scan was made rather than found. A real scan from a real
scanner would be a better witness than the simulated one, and it would drop in
here unchanged.

`tools/nso_relief_test.js` reads `camera.png` with `tools/nso_png.js` (Node has
no JPEG decoder; the shipped path is the browser's). The JPEG is opened only in
real Chromium, through the card's real file input, by
`tools/nso_relief_drive_check.js`.
