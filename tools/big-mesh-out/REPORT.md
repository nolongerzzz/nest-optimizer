### 0f7456c9-ButVase.3mf - 947,444 triangles: main-thread JS, before and after

| gesture | JS before | longest before | JS after | longest after |
|---|--:|--:|--:|--:|
| import | 5.1 s | 4.3 s | 1.6 s | 894 ms |
| idle (nothing selected), 3 s | 4 ms | 2 ms | 2 ms | 1 ms |
| first selection (click) | 33.7 s | 27.0 s | 217 ms | 185 ms |
| 20 hovers (selected, no tool) | 46 ms | 13 ms | 26 ms | 4 ms |
| orbit drag (2 s) | 8 ms | 2 ms | 11 ms | 3 ms |
| open card: measure | 43 ms | 11 ms | 30 ms | 5 ms |
| open card: align | 19 ms | 4 ms | 11 ms | 3 ms |
| open card: connect | 27 ms | 7 ms | 17 ms | 4 ms |
| open card: joins | 23 ms | 6 ms | 16 ms | 4 ms |
| open card: seat | 18 ms | 6 ms | 19 ms | 4 ms |
| open card: supports | 16.5 s | 16.5 s | 333 ms | 174 ms |
| open card: add | 113 ms | 80 ms | 17 ms | 4 ms |
| open card: bit | 24 ms | 4 ms | 101 ms | 28 ms |
| open card: shape | 18 ms | 5 ms | 34 ms | 10 ms |
| open card: paint | 15 ms | 4 ms | 16 ms | 4 ms |
| open card: surface | 26 ms | 5 ms | 11 ms | 3 ms |
| open card: sculpt | 14 ms | 3 ms | 22 ms | 5 ms |
| open card: repair | 14 ms | 4 ms | 15 ms | 4 ms |
| To plate | 5.7 s | 5.7 s | 42 ms | 13 ms |
| open card: cut | 6.0 s | 6.0 s | 95 ms | 61 ms |
| Cut blade appears (click piece) | 244 ms | 238 ms | 37 ms | 29 ms |
| Cut blade: 20 hovers/drag-free moves | 94 ms | 77 ms | 18 ms | 4 ms |
| arm Lift (piece selected) | 3.6 s | 3.6 s | 4.1 s | 4.1 s |
| Lift armed: 20 hovers | 15.2 s | 3.9 s | 129 ms | 32 ms |

Read in the background after the change (opening to the answer, page free meanwhile; before, the same reads ran on the page's thread - the Subtract card's during selection): supports 23.6 s, subtract/split 35.0 s.
