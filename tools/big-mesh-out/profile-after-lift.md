### after-lift: 0f7456c9-ButVase.3mf (947444 triangles)

| gesture | wall ms | JS ms | longest JS run ms | JS runs >50 ms | long tasks (n / max ms) | answered ms |
|---|--:|--:|--:|--:|--:|--:|
| import | 10336 | 1019 | 780 | 2 | 8 / 827 |  |
| idle (nothing selected), 3 s | 3001 | 2 | 1 | 0 | 7 / 661 |  |
| first selection (click) | 6843 | 148 | 124 | 1 | 13 / 831 |  |
| arm Lift (piece selected) | 8200 | 4130 | 4119 | 1 | 9 / 766 |  |
| Lift armed: 20 hovers | 28611 | 129 | 32 | 0 | 44 / 830 |  |

#### what ran in each JS run over 50 ms

- **import** @ +2485 ms, **780 ms** - addModelFromZUpGeometryAsync @ app-core.js:1344 769 > (anonymous) @ app-core.js:1425 769 > addModelFromZUpGeometry @ app-core.js:1310 743 > addModel @ app-core.js:1448 268 | self: setFromBufferAttribute @ three.min.js:6 204, getX @ three.min.js:6 109
- **import** @ +6551 ms, **115 ms** - animate @ app-core.js:964 98 > worker.onmessage @ nso_bvh.js:327 2 > window.nsoPosLockCount @ app-poslock.js:97 1 > window.nsoPosLockHudLine @ app-poslock.js:284 1 | self: bufferData @ (native):0 87, (garbage collector) @ (native):0 14
- **first selection (click)** @ +1901 ms, **124 ms** - onCanvasPointerDown @ app-core.js:2974 122 > window.selectPlaced @ app-sel-outline.js:96 117 > next @ app-seat-grid.js:344 117 > wrapped @ app-split-parts.js:328 117 | self: NSO_cropResolveBox @ app-crop.js:140 28, NSO_cropBoundsWalk @ app-crop.js:71 27
- **arm Lift (piece selected)** @ +666 ms, **4119 ms** - target @ app-lift-plate.js:467 3963 > setArmed @ app-lift-plate.js:581 3963 > readTarget @ app-lift-plate.js:457 3957 > detectNow @ app-lift-plate.js:165 3957 | self: index @ nso_lift_auto.js:180 922, (anonymous) @ nso_lift_auto.js:896 437
