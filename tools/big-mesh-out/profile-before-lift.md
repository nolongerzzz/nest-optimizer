### before-lift: 0f7456c9-ButVase.3mf (947444 triangles)

| gesture | wall ms | JS ms | longest JS run ms | JS runs >50 ms | long tasks (n / max ms) | answered ms |
|---|--:|--:|--:|--:|--:|--:|
| import | 7190 | 2834 | 2484 | 2 | 7 / 755 |  |
| idle (nothing selected), 3 s | 3001 | 3 | 1 | 0 | 6 / 768 |  |
| first selection (click) | 36419 | 28606 | 22708 | 2 | 15 / 22706 |  |
| arm Lift (piece selected) | 7663 | 3575 | 3567 | 1 | 9 / 766 |  |
| Lift armed: 20 hovers | 60726 | 15168 | 3916 | 16 | 43 / 4580 |  |

#### what ran in each JS run over 50 ms

- **import** @ +909 ms, **307 ms** - animate @ app-core.js:959 1 > parseRootModelPart @ nso-3mf-read.js:459 1 > (anonymous) @ nso-3mf-read.js:517 1 > parseModelSettingsNames @ nso-3mf-read.js:438 1 | self: (anonymous) @ (native):0 302, compose @ three.min.js:6 1
- **import** @ +1261 ms, **2484 ms** - (anonymous) @ nso-3mf-read.js:509 1368 > parseModelXml @ nso-3mf-read.js:337 1287 > walkXml @ nso-3mf-read.js:206 1218 > addModelFromZUpGeometry @ app-core.js:1305 736 | self: walkXml @ nso-3mf-read.js:206 828, open @ nso-3mf-read.js:345 233
- **first selection (click)** @ +1986 ms, **5887 ms** - onCanvasPointerDown @ app-core.js:2915 5516 > window.selectPlaced @ app-sel-outline.js:46 5411 > next @ app-seat-grid.js:344 5411 > wrapped @ app-split-parts.js:283 5411 | self: Go @ three.min.js:6 4727, (garbage collector) @ (native):0 361
- **first selection (click)** @ +9359 ms, **22708 ms** - (anonymous) @ app-split-parts.js:131 20687 > analyse @ nso_split_parts.js:231 20686 > read @ app-split-parts.js:95 20686 > cavityShells @ nso_hollow.js:824 19285 | self: indexSoup @ nso_thickness.js:189 14156, cavityShells @ nso_hollow.js:824 3506
- **arm Lift (piece selected)** @ +784 ms, **3567 ms** - target @ app-lift-plate.js:466 3430 > setArmed @ app-lift-plate.js:580 3430 > detectNow @ app-lift-plate.js:165 3429 > (anonymous) @ app-lift-plate.js:162 3429 | self: index @ nso_lift_auto.js:180 754, (anonymous) @ nso_lift_auto.js:896 399
- **Lift armed: 20 hovers** @ +931 ms, **3607 ms** - hoverAt @ app-lift-plate.js:667 3293 > (anonymous) @ app-lift-plate.js:660 3293 > draw @ app-lift-plate.js:1055 3224 > setHover @ app-lift-plate.js:723 3224 | self: key @ app-lift-plate.js:1021 1530, (anonymous) @ app-lift-plate.js:1022 1524
- **Lift armed: 20 hovers** @ +5316 ms, **150 ms** - animate @ app-core.js:959 100 > hitAt @ app-lift-plate.js:604 41 > hoverAt @ app-lift-plate.js:667 41 > (anonymous) @ app-lift-plate.js:660 41 | self: bufferData @ (native):0 33, setFromBufferAttribute @ three.min.js:6 22
- **Lift armed: 20 hovers** @ +8425 ms, **1881 ms** - hoverAt @ app-lift-plate.js:667 1308 > (anonymous) @ app-lift-plate.js:660 1308 > settleFace @ app-lift-plate.js:701 1264 > planeByKey @ app-lift-plate.js:238 1264 | self: planesOf @ app-lift-plate.js:216 785, (garbage collector) @ (native):0 571
- **Lift armed: 20 hovers** @ +11709 ms, **60 ms** - hitAt @ app-lift-plate.js:604 45 > hoverAt @ app-lift-plate.js:667 45 > (anonymous) @ app-lift-plate.js:660 45 > animate @ app-core.js:959 1 | self: (garbage collector) @ (native):0 13, dot @ three.min.js:6 7
- **Lift armed: 20 hovers** @ +12486 ms, **51 ms** - hitAt @ app-lift-plate.js:604 43 > hoverAt @ app-lift-plate.js:667 43 > (anonymous) @ app-lift-plate.js:660 43 > animate @ app-core.js:959 1 | self: dot @ three.min.js:6 9, raycast @ three.min.js:6 9
- **Lift armed: 20 hovers** @ +13960 ms, **72 ms** - hoverAt @ app-lift-plate.js:667 69 > (anonymous) @ app-lift-plate.js:660 69 > hitAt @ app-lift-plate.js:604 69 > viewOf @ app-lift-plate.js:424 1 | self: subVectors @ three.min.js:6 12, crossVectors @ three.min.js:6 9
- **Lift armed: 20 hovers** @ +14775 ms, **3916 ms** - hoverAt @ app-lift-plate.js:667 3602 > (anonymous) @ app-lift-plate.js:660 3602 > draw @ app-lift-plate.js:1055 3535 > setHover @ app-lift-plate.js:723 3535 | self: key @ app-lift-plate.js:1021 1708, (anonymous) @ app-lift-plate.js:1022 1651
- **Lift armed: 20 hovers** @ +19357 ms, **119 ms** - animate @ app-core.js:959 71 > hitAt @ app-lift-plate.js:604 44 > hoverAt @ app-lift-plate.js:667 44 > (anonymous) @ app-lift-plate.js:660 44 | self: bufferData @ (native):0 33, getX @ three.min.js:6 9
- **Lift armed: 20 hovers** @ +22106 ms, **553 ms** - hitAt @ app-lift-plate.js:604 67 > hoverAt @ app-lift-plate.js:667 67 > (anonymous) @ app-lift-plate.js:660 67 | self: (garbage collector) @ (native):0 486, raycast @ three.min.js:6 11
- **Lift armed: 20 hovers** @ +28037 ms, **3573 ms** - hoverAt @ app-lift-plate.js:667 3196 > (anonymous) @ app-lift-plate.js:660 3196 > draw @ app-lift-plate.js:1055 3136 > setHover @ app-lift-plate.js:723 3136 | self: (anonymous) @ app-lift-plate.js:1022 1491, key @ app-lift-plate.js:1021 1434
- **Lift armed: 20 hovers** @ +32255 ms, **105 ms** - animate @ app-core.js:959 60 > hitAt @ app-lift-plate.js:604 44 > hoverAt @ app-lift-plate.js:667 44 > (anonymous) @ app-lift-plate.js:660 44 | self: bufferData @ (native):0 24, dot @ three.min.js:6 9
- **Lift armed: 20 hovers** @ +37654 ms, **71 ms** - hitAt @ app-lift-plate.js:604 70 > hoverAt @ app-lift-plate.js:667 70 > (anonymous) @ app-lift-plate.js:660 70 > animate @ app-core.js:959 1 | self: fromBufferAttribute @ three.min.js:6 11, intersectTriangle @ three.min.js:6 11
- **Lift armed: 20 hovers** @ +43282 ms, **68 ms** - hitAt @ app-lift-plate.js:604 66 > hoverAt @ app-lift-plate.js:667 66 > (anonymous) @ app-lift-plate.js:660 66 > animate @ app-core.js:959 1 | self: subVectors @ three.min.js:6 11, fromBufferAttribute @ three.min.js:6 10
- **Lift armed: 20 hovers** @ +44616 ms, **52 ms** - hoverAt @ app-lift-plate.js:667 50 > (anonymous) @ app-lift-plate.js:660 50 > hitAt @ app-lift-plate.js:604 50 > animate @ app-core.js:959 1 | self: crossVectors @ three.min.js:6 8, raycast @ three.min.js:6 8
- **Lift armed: 20 hovers** @ +47675 ms, **81 ms** - hitAt @ app-lift-plate.js:604 80 > hoverAt @ app-lift-plate.js:667 80 > (anonymous) @ app-lift-plate.js:660 80 > animate @ app-core.js:959 1 | self: crossVectors @ three.min.js:6 13, fromBufferAttribute @ three.min.js:6 12
- **Lift armed: 20 hovers** @ +50658 ms, **56 ms** - hitAt @ app-lift-plate.js:604 54 > hoverAt @ app-lift-plate.js:667 54 > (anonymous) @ app-lift-plate.js:660 54 > animate @ app-core.js:959 1 | self: raycast @ three.min.js:6 10, fromBufferAttribute @ three.min.js:6 9
