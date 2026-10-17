### before: 0f7456c9-ButVase.3mf (947444 triangles)

| gesture | wall ms | JS ms | longest JS run ms | JS runs >50 ms | long tasks (n / max ms) |
|---|--:|--:|--:|--:|--:|
| import | 9083 | 5131 | 4251 | 2 | 6 / 1134 |
| idle (nothing selected), 3 s | 3002 | 4 | 2 | 0 | 6 / 676 |
| first selection (click) | 41909 | 33691 | 27047 | 2 | 14 / 27041 |
| 20 hovers (selected, no tool) | 28504 | 46 | 13 | 0 | 43 / 803 |
| orbit drag (2 s) | 6410 | 8 | 2 | 0 | 10 / 837 |
| open card: measure | 11658 | 43 | 11 | 0 | 18 / 807 |
| open card: align | 11292 | 19 | 4 | 0 | 18 / 795 |
| open card: connect | 11240 | 27 | 7 | 0 | 19 / 813 |
| open card: joins | 11093 | 23 | 6 | 0 | 18 / 743 |
| open card: seat | 11230 | 18 | 6 | 0 | 19 / 813 |
| open card: supports | 28584 | 16501 | 16471 | 1 | 20 / 16439 |
| open card: add | 11635 | 113 | 80 | 1 | 19 / 813 |
| open card: bit | 10603 | 24 | 4 | 0 | 15 / 888 |
| open card: shape | 11240 | 18 | 5 | 0 | 18 / 778 |
| open card: paint | 11935 | 15 | 4 | 0 | 18 / 885 |
| open card: surface | 11624 | 26 | 5 | 0 | 19 / 876 |
| open card: sculpt | 11714 | 14 | 3 | 0 | 17 / 835 |
| open card: repair | 11583 | 14 | 4 | 0 | 18 / 785 |
| To plate | 17025 | 5726 | 5687 | 1 | 19 / 5683 |
| open card: cut | 16685 | 6023 | 5985 | 1 | 18 / 5987 |
| Cut blade appears (click piece) | 5604 | 244 | 238 | 1 | 10 / 753 |
| Cut blade: 20 hovers/drag-free moves | 14722 | 94 | 77 | 1 | 23 / 855 |
| arm Lift | 11636 | 26 | 3 | 0 | 20 / 782 |
| Lift armed: 20 hovers | 27750 | 32 | 6 | 0 | 43 / 813 |

#### what ran in each JS run over 50 ms

- **import** @ +790 ms, **821 ms** - parseRootModelPart @ nso-3mf-read.js:459 1 > (anonymous) @ nso-3mf-read.js:517 1 | self: (anonymous) @ (native):0 813, (garbage collector) @ (native):0 4
- **import** @ +1651 ms, **4251 ms** - (anonymous) @ nso-3mf-read.js:509 1939 > parseModelXml @ nso-3mf-read.js:337 1753 > walkXml @ nso-3mf-read.js:206 1672 > appendTransformed @ nso-3mf-read.js:625 1049 | self: pushVertex @ nso-3mf-read.js:638 1046, walkXml @ nso-3mf-read.js:206 1011
- **first selection (click)** @ +2005 ms, **6613 ms** - onCanvasPointerDown @ app-core.js:2915 6160 > wrapped @ app-split-parts.js:283 6021 > window.selectPlaced @ app-sel-outline.js:46 6020 > next @ app-seat-grid.js:344 6020 | self: Go @ three.min.js:6 5321, (garbage collector) @ (native):0 447
- **first selection (click)** @ +10315 ms, **27047 ms** - (anonymous) @ app-split-parts.js:131 24612 > analyse @ nso_split_parts.js:231 24612 > read @ app-split-parts.js:95 24612 > cavityShells @ nso_hollow.js:824 22678 | self: indexSoup @ nso_thickness.js:189 15931, cavityShells @ nso_hollow.js:824 4171
- **open card: supports** @ +8317 ms, **16471 ms** - pick @ app-supports-card.js:570 15025 > open @ app-supports-card.js:1018 15025 > (anonymous) @ app-supports-card.js:1078 15025 > refresh @ app-supports-card.js:551 9505 | self: Go @ three.min.js:6 4734, make @ nso_support_aim.js:532 3129
- **open card: add** @ +5747 ms, **80 ms** - animate @ app-core.js:959 1 | self: (garbage collector) @ (native):0 77, elementState @ (native):6955 1
- **To plate** @ +7416 ms, **5687 ms** - refreshOutline @ app-sel-outline.js:19 5305 > wrapped @ app-cth.js:45 5305 > bringSelectedToPlate @ app-core.js:3650 5305 > (anonymous) @ app-join.js:3661 5305 | self: Go @ three.min.js:6 4781, (garbage collector) @ (native):0 372
- **open card: cut** @ +7246 ms, **5985 ms** - (anonymous) @ app-cut.js:489 5409 > MutationObserver.observe.attributes @ app-cut.js:488 5409 > openCutter @ app-cut.js:429 5403 > next @ app-seat-grid.js:344 5400 | self: Go @ three.min.js:6 4605, (garbage collector) @ (native):0 567
- **Cut blade appears (click piece)** @ +2364 ms, **238 ms** - onCanvasPointerDown @ app-core.js:2915 229 > cutTFromPointer @ app-core.js:2693 168 > updateCutHelper @ app-crop.js:1416 132 > NSO_cropSyncUI @ app-crop.js:1224 116 | self: NSO_cropBounds @ app-crop.js:56 54, setFromBufferAttribute @ three.min.js:6 43
- **Cut blade: 20 hovers/drag-free moves** @ +2465 ms, **77 ms** - animate @ app-core.js:959 1 | self: (garbage collector) @ (native):0 75, Ut @ three.min.js:6 1
