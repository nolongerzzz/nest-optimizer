# Flow test tube

A 50 mm tube, 33 mm tall, for the Print card's **Flow test** row (2026-11-25, the owner's PETG on the P1S). Slice it with Wall loops 2,
sparse infill 0 %, top layers 0, no brim, and Flow test `10, 2, 3`: from the second layer every line prints at exactly 10 mm³/s of
filament through the hotend, then 12 from 3 mm, 14 from 6 mm ... 30 from 30 mm (the flow ratio is counted). There's no slowing for
layer time, and the filament's own max flow is set aside for the test. Each band is marked in the G-code (`; NSO flow test:`).

Read it: the band where the walls start to go matte, thin, gappy or rough is past the hotend's limit. Take the last clean band, less
about 10 %, as the filament's max flow on that printer and nozzle.

| Height (mm) | 0.2 - 3 | 3 - 6 | 6 - 9 | 9 - 12 | 12 - 15 | 15 - 18 | 18 - 21 | 21 - 24 | 24 - 27 | 27 - 30 | 30 - 33 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mm³/s | 10 | 12 | 14 | 16 | 18 | 20 | 22 | 24 | 26 | 28 | 30 |
