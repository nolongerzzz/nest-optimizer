# Thingi10K fixtures for NSO_Repair — NOT IN THE REPO

Three real meshes are part of the NSO_Repair regression suite. They are **not
committed here**, and they were **not obtainable in the session that built this
module**: outbound network in the build environment is limited to a short
allowlist (npm, PyPI, GitHub and similar) and `thingiverse.com` is not on it —
a `CONNECT` to it is answered `403` by the proxy. Every alternate host tried
(`cdn.thingiverse.com`, `files.thingiverse.com`, the Thingi10K app-engine API,
an archive.org mirror, a Hugging Face mirror) was refused the same way.

So the three cases below are wired into `tools/nso_repair_regress.js` but have
**never been run**. The runner reports them as `MISS`, labels their
expectations `PROVISIONAL`, and exits non-zero — it does not report a pass it
did not earn.

## What to drop in

| file         | Thingi10K id | role in the suite |
|--------------|--------------|-------------------|
| `40921.stl`  | 40921        | clean baseline — repair must be a no-op |
| `37825.stl`  | 37825        | self-touching single sheet — must decline (out of scope) |
| `39644.stl`  | 39644        | 3-sheet closed solid — gate must block the split |

Put them in this directory under exactly those names and re-run:

```sh
node tools/nso_repair_regress.js
```

No other change is needed. The three cases become live automatically.

## Expected numbers, and how much to trust them

These come from the ticket that specified this module, not from a measurement
made against this implementation:

- **40921** — 0 splits, 0 changes, exact volume match, watertight before and
  after. `commit()` must hand back the caller's own array.
- **37825** — untouched. The defect is a single sheet touching itself, which
  needs local re-triangulation / neck-bridging; this module has no such stage,
  so declining is the correct result, not a failure.
- **39644** — the gate blocks the risky split: applying it would take
  self-intersections from 0 to 9. The file is left unchanged.

Treat a failure on these as ambiguous until someone has looked: it may mean the
module regressed, or it may mean the transcribed number never matched this
implementation in the first place. The synthetic fixtures next door are the
unambiguous gate — every number there was measured against this code.

Once these three have actually been run, replace this section with the measured
values and drop `provisional: true` from the three cases in
`tools/nso_repair_regress.js`.
