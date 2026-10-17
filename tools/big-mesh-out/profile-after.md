### after: 0f7456c9-ButVase.3mf (947444 triangles)

| gesture | wall ms | JS ms | longest JS run ms | JS runs >50 ms | long tasks (n / max ms) | answered ms |
|---|--:|--:|--:|--:|--:|--:|
| import | 11837 | 1648 | 894 | 2 | 15 / 1304 |  |
| idle (nothing selected), 3 s | 3001 | 2 | 1 | 0 | 7 / 758 |  |
| first selection (click) | 7372 | 217 | 185 | 1 | 13 / 1146 |  |
| 20 hovers (selected, no tool) | 27544 | 26 | 4 | 0 | 42 / 823 |  |
| orbit drag (2 s) | 7600 | 11 | 3 | 0 | 12 / 738 |  |
| open card: measure | 10427 | 30 | 5 | 0 | 17 / 778 | 9648 |
| open card: align | 9997 | 11 | 3 | 0 | 18 / 746 | 9405 |
| open card: connect | 10718 | 17 | 4 | 0 | 17 / 829 | 10066 |
| open card: joins | 10234 | 16 | 4 | 0 | 17 / 761 | 9571 |
| open card: seat | 10086 | 19 | 4 | 0 | 17 / 750 | 9472 |
| open card: supports | 24173 | 333 | 174 | 2 | 36 / 1043 | 23575 |
| open card: add | 10431 | 17 | 4 | 0 | 17 / 715 | 9719 |
| open card: bit | 35740 | 101 | 28 | 0 | 46 / 1139 | 34995 |
| open card: shape | 10026 | 34 | 10 | 0 | 17 / 706 | 9396 |
| open card: paint | 9966 | 16 | 4 | 0 | 17 / 719 | 9341 |
| open card: surface | 10302 | 11 | 3 | 0 | 18 / 737 | 9678 |
| open card: sculpt | 10829 | 22 | 5 | 0 | 18 / 775 | 10168 |
| open card: repair | 10441 | 15 | 4 | 0 | 18 / 761 | 9713 |
| To plate | 10856 | 42 | 13 | 0 | 17 / 754 |  |
| open card: cut | 10129 | 95 | 61 | 1 | 18 / 723 |  |
| Cut blade appears (click piece) | 5262 | 37 | 29 | 0 | 10 / 765 |  |
| Cut blade: 20 hovers/drag-free moves | 13497 | 18 | 4 | 0 | 23 / 739 |  |
| arm Lift | 9967 | 23 | 4 | 0 | 17 / 806 |  |
| Lift armed: 20 hovers | 26533 | 25 | 2 | 0 | 42 / 752 |  |

#### what ran in each JS run over 50 ms

- **import** @ +2995 ms, **894 ms** - addModelFromZUpGeometryAsync @ app-core.js:1344 881 > (anonymous) @ app-core.js:1425 881 > addModelFromZUpGeometry @ app-core.js:1310 811 > addModel @ app-core.js:1448 287 | self: setFromBufferAttribute @ three.min.js:6 222, getX @ three.min.js:6 129
- **import** @ +7951 ms, **579 ms** - animate @ app-core.js:964 559 > worker.onmessage @ nso_bvh.js:325 2 > updateAdjustUI @ app-core.js:3419 1 > placeModelMovable @ app-core.js:1548 1 | self: bufferData @ (native):0 539, (garbage collector) @ (native):0 16
- **first selection (click)** @ +2015 ms, **185 ms** - onCanvasPointerDown @ app-core.js:2974 178 > wrapped @ app-split-parts.js:328 172 > window.selectPlaced @ app-sel-outline.js:96 172 > next @ app-seat-grid.js:344 172 | self: NSO_cropBoundsWalk @ app-crop.js:71 43, NSO_cropResolveBox @ app-crop.js:140 38
- **open card: supports** @ +7839 ms, **174 ms** - pick @ app-supports-card.js:603 160 > open @ app-supports-card.js:1052 160 > (anonymous) @ app-supports-card.js:1113 160 > refresh @ app-supports-card.js:584 125 | self: meshToWorldSoup @ app-join.js:216 61, NSO_cropResolveBox @ app-crop.js:140 31
- **open card: supports** @ +21816 ms, **115 ms** - (anonymous) @ app-supports-card.js:193 84 > refresh @ app-supports-card.js:584 56 > boundsOf @ app-supports-card.js:114 52 > draw @ app-supports-card.js:437 52 | self: boundsOf @ app-supports-card.js:114 52, getProgramInfoLog @ (native):0 9
- **open card: cut** @ +6494 ms, **61 ms** - openCutter @ app-cut.js:435 58 > (anonymous) @ app-cut.js:495 58 > MutationObserver.observe.attributes @ app-cut.js:494 58 > wrapped @ app-split-parts.js:328 58 | self: NSO_cropResolveBox @ app-crop.js:140 55, (garbage collector) @ (native):0 2
