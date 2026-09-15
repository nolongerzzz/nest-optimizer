#!/usr/bin/env python3
"""Breakaway-support test-coupon plate generator.

Builds a plate of small two-part coupons for physically validating breakaway
supports, exports it as a print-ready Bambu Studio project (.3mf) plus a
labelled mapping file, and refuses to export any object that fails the
watertight / degenerate-triangle check.

    python3 tools/breakaway_coupons.py                 # out/breakaway-coupons/
    python3 tools/breakaway_coupons.py --out-dir DIR --stl-dir DIR/stl
    python3 tools/breakaway_coupons.py --help

WHAT A COUPON IS
Two independently watertight objects that are NOT merged: an "anchor" standing
on the bed (it plays the support) and a "breakaway" sitting on top of it (it
plays the part). They coincide at the interface: the breakaway's bottom is at
the anchor's top plus the gap/overlap value, so the slicer sees two objects
whose toolpaths touch (or don't) exactly where the sweep says. Every object is a
concatenation of overlapping closed shells (body + interface features), the
same construction tools/csg_bench/make_fixtures.py and the app use, with no
boolean engine.

THE TWO MECHANISMS ENCODED (from the physical prints; not re-derived here)
  1. Weld cross-section minimised geometrically.
       ring  - the anchor ends in a thin ring tip (0.8 mm wall tapering to
               0.4 mm); the breakaway's bottom is flat. Nominal contact is a
               0.4 mm x 2*pi*4.6 mm annulus, ~11.6 mm^2.
       grid  - the anchor ends in parallel ribs along X, the breakaway starts
               with parallel ribs along Y; they touch only at the crossings,
               16 x 0.5 x 0.5 mm, ~4 mm^2 - the "near-zero footprint" family.
  2. Weld thermal conditions denied by a print pause at the joint transition
     (~20-25 s). Encoded with Bambu Studio's own per-layer pause part
     (Metadata/custom_gcode_per_layer.xml, the layer-slider pause), because
     nothing in this pipeline expresses pauses yet and Bambu's native one is
     what a layer-slider pause on the printer is. A layer pause is plate-wide,
     so pause coupons live on their own Z tier(s): their joints sit at a Z no
     other coupon's joint uses, and the pause fires at exactly that layer. A
     no-pause coupon only ever sees that pause several millimetres above or
     below its joint, inside a solid body. The generator checks this isolation
     and refuses to export if it does not hold.

THE SWEEP
  gap/overlap  -0.20 (gap, expected easy release) ... +0.02 (overlap, expected
               solid fuse); -0.10 and -0.05 are the prior reference points.
               Negative = air gap between anchor top and breakaway bottom,
               positive = the breakaway penetrates the anchor's tip.
  geometry     ring, grid
  pause        no / yes (yes tested across the same gaps; -0.20 + pause is
               the confirmed combination)

LAYER QUANTISATION (read this before trusting a sub-layer gap)
A slicer prints whole layers on the plate's layer grid. The breakaway's first
layer is the first layer whose slice plane (print_z - h/2) lies inside it, so
with 0.2 mm layers a -0.05 gap and a 0 gap slice identically, -0.15 and -0.20
slice identically, and -0.10 puts the bottom face exactly on a slice plane
(reported as AMBIGUOUS in the mapping). The mapping records the predicted
touchdown layer for every coupon so the physical result can be read against
what was actually extruded. Change --layer-height to move the boundaries.

OUTPUT
  breakaway_coupon_plate.3mf   the plate (open as a PROJECT in Bambu Studio,
                               not "import geometry", so object positions,
                               the pause and the settings all load; do not
                               "Arrange" or "drop to bed" afterwards)
  breakaway_coupon_map.json    full parameter map, machine-readable
  breakaway_coupon_map.txt     the same as a table, for the bench
  --stl-dir                    one binary STL per object, optional

Stdlib only. Depends on tools/meshlib.py and tools/nso_3mf.py.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import meshlib as M  # noqa: E402
import nso_3mf  # noqa: E402

VERSION = "1.0.0"
GEOMETRIES = ("ring", "grid")
PAUSE_MODES = ("native", "dwell")

# Stock cooling values, a copy of DEFAULT_VALUES in nso-cooling-profiles.js so
# this tool runs with no Node. When Node is present the JS module is asked
# instead (single source of truth); tools/breakaway_test asserts the two agree.
COOLING_DEFAULT_VALUES = (
    ("enable_overhang_bridge_fan", "1"),
    ("overhang_fan_threshold", "50%"),
    ("overhang_threshold_participating_cooling", "95%"),
    ("overhang_fan_speed", "100"),
    ("pre_start_fan_time", "2"),
    ("reduce_fan_stop_start_freq", "1"),
    ("slow_down_for_layer_cooling", "1"),
    ("fan_min_speed", "60"),
    ("fan_cooling_layer_time", "80"),
    ("fan_max_speed", "80"),
    ("slow_down_layer_time", "6"),
    ("slow_down_min_speed", "20"),
    ("no_slow_down_for_cooling_on_outwalls", "0"),
    ("cooling_slowdown_logic", "uniform_cooling"),
)


# ============================================================================
# Specification
# ============================================================================

@dataclass
class PlateSpec:
    gaps: Tuple[float, ...] = (-0.20, -0.15, -0.10, -0.05, 0.0, 0.02)
    geometries: Tuple[str, ...] = GEOMETRIES
    pause_rows: bool = True                 # add a pause row per geometry
    pause_gaps: Optional[Tuple[float, ...]] = None   # None = same as gaps
    pause_seconds: float = 22.0
    pause_mode: str = "native"              # native (M400 U1, resume by hand) | dwell (G4)

    layer_height: float = 0.2
    first_layer_height: float = 0.2

    plate_size: Tuple[float, float] = (256.0, 256.0)
    spacing: float = 10.0                   # clear gap between coupons
    coupon_size: float = 16.0               # anchor footprint, square
    breakaway_size: float = 14.0            # breakaway footprint, square
    breakaway_height: float = 5.0           # breakaway body height above its interface
    anchor_top_nopause: float = 6.0         # joint Z for no-pause coupons
    pause_tier_base: float = 9.0            # joint Z for the first pause tier
    pause_tier_step: float = 3.0            # next pause tier, when the sweep needs one
    tip_height: float = 1.0                 # interface feature height
    embed: float = 0.2                      # how far a feature sinks into its body (overlap union)

    ring_r_out: float = 5.0
    ring_wall_base: float = 0.8
    ring_wall_tip: float = 0.4
    ring_segments: int = 96

    rib_width: float = 0.5
    rib_pitch: float = 3.0
    rib_count: int = 4
    rib_span: float = 12.0

    notch_width: float = 1.0
    notch_depth: float = 0.8
    notch_pitch: float = 1.8
    notch_margin: float = 1.5

    cooling_profile: str = "default"

    def pitch(self) -> float:
        return self.coupon_size + self.spacing


# ============================================================================
# Layer-grid arithmetic
# ============================================================================

def is_layer_aligned(z: float, spec: PlateSpec, tol: float = 1e-6) -> bool:
    if z < spec.first_layer_height - tol:
        return False
    n = (z - spec.first_layer_height) / spec.layer_height
    return abs(n - round(n)) < tol


def touchdown(bottom: float, spec: PlateSpec) -> Tuple[float, bool]:
    """print_z of the first layer whose slice plane lies inside a solid whose
    lowest face is at `bottom`, and whether that face sits on a slice plane."""
    z = spec.first_layer_height
    h = spec.first_layer_height
    ambiguous = False
    for _ in range(100000):
        mid = z - h / 2.0
        if abs(mid - bottom) < 1e-6:
            ambiguous = True
        if mid > bottom + 1e-6:
            return round(z, 6), ambiguous
        h = spec.layer_height
        z += spec.layer_height
    raise ValueError("touchdown: bottom %.3f is above any plausible layer" % bottom)


# ============================================================================
# Geometry
# ============================================================================

def notched_square(size: float, front_notches: int, left_notches: int, spec: PlateSpec) -> List[Tuple[float, float]]:
    """Square of `size` centred on the origin, CCW, with `front_notches`
    rectangular notches cut into the -Y edge and `left_notches` into the -X
    edge. Notch count is how a coupon stays identifiable off the plate:
    front = column, left = row."""
    half = size / 2.0
    w, d, p, m = spec.notch_width, spec.notch_depth, spec.notch_pitch, spec.notch_margin

    def starts(count: int) -> List[float]:
        if count <= 0:
            return []
        run = count * w + (count - 1) * (p - w)
        if run > size - 2 * m:
            raise ValueError("%d notches do not fit on a %.1f mm edge" % (count, size))
        s0 = -run / 2.0
        return [s0 + i * p for i in range(count)]

    poly: List[Tuple[float, float]] = [(-half, -half)]
    for s in starts(front_notches):                 # -Y edge, walking +X
        poly += [(s, -half), (s, -half + d), (s + w, -half + d), (s + w, -half)]
    poly += [(half, -half), (half, half), (-half, half)]
    for s in reversed(starts(left_notches)):        # -X edge, walking -Y
        poly += [(-half, s + w), (-half + d, s + w), (-half + d, s), (-half, s)]
    return poly


def rib_centres(spec: PlateSpec) -> List[float]:
    n = spec.rib_count
    return [(i - (n - 1) / 2.0) * spec.rib_pitch for i in range(n)]


def contact_footprint_mm2(geometry: str, spec: PlateSpec) -> float:
    if geometry == "ring":
        # The tip's outer radius is r_out minus half the taper; its centre line
        # is half a tip-wall further in.
        r_tip_out = spec.ring_r_out - (spec.ring_wall_base - spec.ring_wall_tip) / 2.0
        r_mid = r_tip_out - spec.ring_wall_tip / 2.0
        return 2 * math.pi * r_mid * spec.ring_wall_tip
    if geometry == "grid":
        return spec.rib_count * spec.rib_count * spec.rib_width ** 2
    raise ValueError(geometry)


@dataclass
class Part:
    name: str
    tris: list


@dataclass
class CouponObject:
    role: str                      # anchor | breakaway
    name: str
    object_id: int                 # 1-based position in the 3MF
    identify_id: int
    parts: List[Part]
    tris: list = field(default_factory=list)
    report: dict = field(default_factory=dict)


@dataclass
class Coupon:
    index: int
    row: int
    col: int
    geometry: str
    gap: float
    pause: bool
    x: float
    y: float
    z_top: float                   # joint: anchor's top surface
    bottom: float                  # breakaway's lowest face = z_top - gap
    touchdown_z: float
    ambiguous: bool
    tier: str
    anchor: Optional[CouponObject] = None
    breakaway: Optional[CouponObject] = None

    @property
    def label(self) -> str:
        return "C%02d_%s_g%+.2f_%s" % (self.index, self.geometry, self.gap, "P" if self.pause else "N")


def build_anchor_parts(c: Coupon, spec: PlateSpec) -> List[Part]:
    body_top = c.z_top - spec.tip_height
    outline = notched_square(spec.coupon_size, c.col, c.row, spec)
    parts = [Part("body", M.extrude_polygon(outline, 0.0, body_top))]
    z0 = body_top - spec.embed
    if c.geometry == "ring":
        ro = spec.ring_r_out
        parts.append(Part("ring_tip", M.tapered_ring(
            0.0, 0.0, z0, c.z_top,
            ro, ro - (spec.ring_wall_base - spec.ring_wall_tip) / 2.0,
            ro - spec.ring_wall_base, ro - spec.ring_wall_base + (spec.ring_wall_base - spec.ring_wall_tip) / 2.0,
            spec.ring_segments)))
    elif c.geometry == "grid":
        hw, hs = spec.rib_width / 2.0, spec.rib_span / 2.0
        for i, yc in enumerate(rib_centres(spec)):
            parts.append(Part("rib_x%d" % i, M.box(-hs, hs, yc - hw, yc + hw, z0, c.z_top)))
    else:
        raise ValueError(c.geometry)
    return [Part(p.name, M.translate(p.tris, c.x, c.y, 0.0)) for p in parts]


def build_breakaway_parts(c: Coupon, spec: PlateSpec) -> List[Part]:
    outline = notched_square(spec.breakaway_size, c.col, c.row, spec)
    parts: List[Part] = []
    if c.geometry == "ring":
        body_z0 = c.bottom
    elif c.geometry == "grid":
        body_z0 = c.bottom + spec.tip_height
        hw, hs = spec.rib_width / 2.0, spec.rib_span / 2.0
        for i, xc in enumerate(rib_centres(spec)):
            parts.append(Part("rib_y%d" % i, M.box(xc - hw, xc + hw, -hs, hs, c.bottom, body_z0 + spec.embed)))
    else:
        raise ValueError(c.geometry)
    parts.append(Part("body", M.extrude_polygon(outline, body_z0, body_z0 + spec.breakaway_height)))
    return [Part(p.name, M.translate(p.tris, c.x, c.y, 0.0)) for p in parts]


# ============================================================================
# Plate planning
# ============================================================================

@dataclass
class PauseEntry:
    top_z: float
    tier: str
    z_top: float
    coupons: List[int]


@dataclass
class Plate:
    spec: PlateSpec
    coupons: List[Coupon]
    tiers: Dict[str, float]
    pauses: List[PauseEntry]
    rows: int
    cols: int
    objects: List[CouponObject] = field(default_factory=list)


def plan_plate(spec: PlateSpec) -> Plate:
    for g in spec.geometries:
        if g not in GEOMETRIES:
            raise ValueError("unknown geometry %r (have %s)" % (g, ", ".join(GEOMETRIES)))
    if spec.pause_mode not in PAUSE_MODES:
        raise ValueError("unknown pause mode %r" % spec.pause_mode)
    for name, z in (("anchor_top_nopause", spec.anchor_top_nopause),
                    ("pause_tier_base", spec.pause_tier_base),
                    ("tip_height", spec.tip_height + spec.first_layer_height),
                    ("pause_tier_step", spec.pause_tier_step + spec.first_layer_height)):
        if not is_layer_aligned(z, spec):
            raise ValueError("%s must sit on the layer grid (first %.3f, layer %.3f)" % (
                name, spec.first_layer_height, spec.layer_height))

    pause_gaps = tuple(spec.pause_gaps) if spec.pause_gaps is not None else tuple(spec.gaps)
    rows: List[Tuple[bool, str]] = [(False, g) for g in spec.geometries]
    if spec.pause_rows:
        rows += [(True, g) for g in spec.geometries]
    cols = list(spec.gaps)

    # Pause tiers: group pause gaps by where their touchdown lands relative to
    # the joint, one tier per distinct offset, so one plate-wide pause serves a
    # whole group at exactly its touchdown layer.
    offsets: List[float] = []
    for g in (pause_gaps if spec.pause_rows else ()):
        tz, _ = touchdown(spec.pause_tier_base - g, spec)
        off = round(tz - spec.pause_tier_base, 6)
        if off not in offsets:
            offsets.append(off)
    offsets.sort()
    tier_z: Dict[str, float] = {"N": spec.anchor_top_nopause}
    offset_tier: Dict[float, str] = {}
    for k, off in enumerate(offsets):
        name = "P%d" % (k + 1)
        tier_z[name] = round(spec.pause_tier_base + k * spec.pause_tier_step, 6)
        offset_tier[off] = name

    pitch = spec.pitch()
    cx, cy = spec.plate_size[0] / 2.0, spec.plate_size[1] / 2.0
    coupons: List[Coupon] = []
    idx = 0
    for r, (pause, geom) in enumerate(rows):
        for ccol, gap in enumerate(cols):
            if pause and gap not in pause_gaps:
                continue
            idx += 1
            if pause:
                tz0, _ = touchdown(spec.pause_tier_base - gap, spec)
                tier = offset_tier[round(tz0 - spec.pause_tier_base, 6)]
            else:
                tier = "N"
            z_top = tier_z[tier]
            bottom = round(z_top - gap, 6)
            tz, amb = touchdown(bottom, spec)
            coupons.append(Coupon(
                index=idx, row=r + 1, col=ccol + 1, geometry=geom, gap=gap, pause=pause,
                x=round(cx + (ccol - (len(cols) - 1) / 2.0) * pitch, 6),
                y=round(cy + (r - (len(rows) - 1) / 2.0) * pitch, 6),
                z_top=z_top, bottom=bottom, touchdown_z=tz, ambiguous=amb, tier=tier))

    pauses: List[PauseEntry] = []
    for off in offsets:
        tier = offset_tier[off]
        members = [c.index for c in coupons if c.pause and c.tier == tier]
        if members:
            pauses.append(PauseEntry(top_z=round(tier_z[tier] + off, 6), tier=tier,
                                     z_top=tier_z[tier], coupons=members))

    plate = Plate(spec=spec, coupons=coupons, tiers=tier_z, pauses=pauses, rows=len(rows), cols=len(cols))
    check_layout(plate)
    check_pause_isolation(plate)
    return plate


def check_layout(plate: Plate) -> None:
    spec = plate.spec
    half = spec.coupon_size / 2.0
    for c in plate.coupons:
        if not (half <= c.x <= spec.plate_size[0] - half and half <= c.y <= spec.plate_size[1] - half):
            raise ValueError("coupon %s at (%.1f, %.1f) is off the %.0f x %.0f plate" % (
                c.label, c.x, c.y, spec.plate_size[0], spec.plate_size[1]))
    for a in plate.coupons:
        for b in plate.coupons:
            if a.index < b.index:
                if abs(a.x - b.x) < spec.coupon_size + spec.spacing - 1e-6 and \
                   abs(a.y - b.y) < spec.coupon_size + spec.spacing - 1e-6:
                    raise ValueError("coupons %s and %s closer than the spacing" % (a.label, b.label))


def check_pause_isolation(plate: Plate) -> None:
    """Every pause must fire at exactly one joint transition: its own tier's,
    and never inside the (z_top, touchdown] window of any other coupon."""
    tol = 1e-6
    for c in plate.coupons:
        own = [p for p in plate.pauses if c.index in p.coupons]
        if c.pause and len(own) != 1:
            raise ValueError("pause coupon %s has %d pause entries, expected 1" % (c.label, len(own)))
        for p in plate.pauses:
            inside = c.z_top + tol < p.top_z <= c.touchdown_z + tol
            if inside and c.index not in p.coupons:
                raise ValueError("pause at z=%.2f lands in the joint window of %s (z_top %.2f, touchdown %.2f)" % (
                    p.top_z, c.label, c.z_top, c.touchdown_z))
            if c.index in p.coupons and abs(p.top_z - c.touchdown_z) > tol:
                raise ValueError("pause for %s is at z=%.2f but its touchdown is %.2f" % (
                    c.label, p.top_z, c.touchdown_z))


# ============================================================================
# Build + verify
# ============================================================================

def build_objects(plate: Plate) -> None:
    spec = plate.spec
    objects: List[CouponObject] = []
    for c in plate.coupons:
        for role, builder in (("anchor", build_anchor_parts), ("breakaway", build_breakaway_parts)):
            parts = builder(c, spec)
            oid = len(objects) + 1
            obj = CouponObject(role=role, name="%s_%s" % (c.label, role), object_id=oid,
                               identify_id=1000 + oid, parts=parts)
            obj.tris = M.concat(*[p.tris for p in parts])
            objects.append(obj)
            setattr(c, role, obj)
    plate.objects = objects


def verify_objects(plate: Plate) -> List[str]:
    """Run meshlib.verify on every part and every whole object. Returns the
    failure lines; empty means everything passed."""
    failures: List[str] = []
    for obj in plate.objects:
        for p in obj.parts:
            rep = M.verify(p.tris)
            if not rep["ok"]:
                failures.append("%s / %s: %s" % (obj.name, p.name, M.describe_failure(rep)))
        obj.report = M.verify(obj.tris)
        if not obj.report["ok"]:
            failures.append("%s: %s" % (obj.name, M.describe_failure(obj.report)))
    return failures


# ============================================================================
# Settings + pause encoding
# ============================================================================

def cooling_values(profile: str) -> Tuple[Dict[str, List[str]], str]:
    """(values, source). Asks nso-cooling-profiles.js through Node when Node is
    available so a tuned profile is honoured; otherwise the embedded copy of
    the stock values (which is all an untuned profile resolves to anyway)."""
    js = os.path.join(ROOT, "nso-cooling-profiles.js")
    if os.path.exists(js):
        try:
            out = subprocess.run(
                ["node", "-e",
                 "const P=require(process.argv[1]);"
                 "if(!P.hasProfile(process.argv[2]))process.exit(3);"
                 "process.stdout.write(P.serializeProjectSettings(P.resolveValues(process.argv[2])))",
                 js, profile],
                capture_output=True, text=True, timeout=30)
            if out.returncode == 3:
                raise ValueError("cooling profile %r is not in nso-cooling-profiles.js" % profile)
            if out.returncode == 0:
                vals = json.loads(out.stdout)
                return vals, "nso-cooling-profiles.js via node"
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            pass
    if profile != "default":
        raise ValueError("cooling profile %r needs Node to resolve; only 'default' is embedded" % profile)
    return {k: [v] for k, v in COOLING_DEFAULT_VALUES}, "embedded copy of DEFAULT_VALUES"


def project_settings(spec: PlateSpec) -> Tuple[str, str]:
    vals, source = cooling_values(spec.cooling_profile)
    settings: Dict[str, object] = {}
    settings.update(vals)
    # Print-level keys are plain strings in Bambu's own files
    # (fixtures/3mf/pa_pattern.3mf). The pause Z values assume this grid.
    settings["layer_height"] = nso_3mf.num(spec.layer_height)
    settings["initial_layer_print_height"] = nso_3mf.num(spec.first_layer_height)
    settings["print_sequence"] = "by layer"
    return nso_3mf.serialize_project_settings(settings), source


def dwell_gcode(seconds: float, entry: PauseEntry) -> str:
    return "\n".join([
        "; NSO breakaway coupon: timed pause at the joint transition, tier %s (joint z=%s)" % (entry.tier, nso_3mf.num(entry.z_top)),
        "M400 ; finish buffered moves",
        "M83 ; relative extrusion (what Bambu Studio already uses)",
        "G1 E-2 F1800 ; retract",
        "G91 ; relative moves",
        "G1 Z5 F600 ; lift the nozzle clear of the joint",
        "G90 ; absolute moves",
        "G4 S%s ; dwell, part fan stays on" % nso_3mf.num(seconds),
        "G91",
        "G1 Z-5 F600 ; back down",
        "G90",
        "G1 E2 F1800 ; unretract",
        "; NSO breakaway coupon: resume",
    ])


def pause_layers(plate: Plate) -> List[nso_3mf.LayerGcode]:
    spec = plate.spec
    out: List[nso_3mf.LayerGcode] = []
    for p in plate.pauses:
        if spec.pause_mode == "native":
            msg = "NSO breakaway coupons tier %s: wait %s s, then resume" % (p.tier, nso_3mf.num(spec.pause_seconds))
            out.append(nso_3mf.LayerGcode(p.top_z, nso_3mf.GCODE_TYPE_PAUSE, msg))
        else:
            out.append(nso_3mf.LayerGcode(p.top_z, nso_3mf.GCODE_TYPE_CUSTOM, dwell_gcode(spec.pause_seconds, p)))
    return out


# ============================================================================
# Mapping
# ============================================================================

def gap_word(gap: float) -> str:
    if gap < 0:
        return "gap"
    if gap > 0:
        return "overlap"
    return "flush"


def mapping_dict(plate: Plate, parts_written: Sequence[str]) -> dict:
    spec = plate.spec
    coupons = []
    for c in plate.coupons:
        coupons.append({
            "coupon": c.index,
            "label": c.label,
            "position": "r%dc%d" % (c.row, c.col),
            "row": c.row, "col": c.col,
            "x_mm": c.x, "y_mm": c.y,
            "geometry": c.geometry,
            "gap_overlap_mm": c.gap,
            "gap_kind": gap_word(c.gap),
            "pause": c.pause,
            "pause_seconds": spec.pause_seconds if c.pause else 0,
            "tier": c.tier,
            "joint_z_mm": c.z_top,
            "breakaway_bottom_z_mm": c.bottom,
            "predicted_touchdown_layer_z_mm": c.touchdown_z,
            # Same sign convention as gap_overlap_mm: negative = air gap. An
            # overlap cannot survive quantisation either, so >= 0 reads 0.
            "predicted_sliced_gap_mm": round(-(c.touchdown_z - spec.layer_height - c.z_top), 6),
            "touchdown_ambiguous": c.ambiguous,
            "notches": {"front_edge_minus_y": c.col, "left_edge_minus_x": c.row},
            "nominal_contact_mm2": round(contact_footprint_mm2(c.geometry, spec), 3),
            "objects": {
                "anchor": {"object_id": c.anchor.object_id, "identify_id": c.anchor.identify_id, "name": c.anchor.name},
                "breakaway": {"object_id": c.breakaway.object_id, "identify_id": c.breakaway.identify_id, "name": c.breakaway.name},
            },
        })
    objects = []
    for o in plate.objects:
        lo, hi = M.bbox(o.tris)
        objects.append({
            "object_id": o.object_id, "identify_id": o.identify_id, "name": o.name, "role": o.role,
            "parts": [p.name for p in o.parts],
            "triangles": o.report["tris"],
            "volume_mm3": round(o.report["signed_volume"], 4),
            "bbox_mm": [[round(v, 4) for v in lo], [round(v, 4) for v in hi]],
            "verify": {k: v for k, v in o.report.items() if k != "signed_volume"},
        })
    return {
        "generator": "tools/breakaway_coupons.py",
        "version": VERSION,
        "plate": {
            "size_mm": list(spec.plate_size),
            "rows": plate.rows, "cols": plate.cols,
            "pitch_mm": spec.pitch(), "spacing_mm": spec.spacing,
            "coupon_size_mm": spec.coupon_size, "breakaway_size_mm": spec.breakaway_size,
            "layer_height_mm": spec.layer_height, "first_layer_height_mm": spec.first_layer_height,
            "print_sequence": "by layer",
            "cooling_profile": spec.cooling_profile,
            "parts_in_3mf": list(parts_written),
        },
        "tiers": [{"tier": k, "joint_z_mm": v, "pause": k != "N"} for k, v in plate.tiers.items()],
        "pause": {
            "seconds": spec.pause_seconds,
            "mode": spec.pause_mode,
            "encoding": "Metadata/custom_gcode_per_layer.xml, type %d (%s)" % (
                nso_3mf.GCODE_TYPE_PAUSE if spec.pause_mode == "native" else nso_3mf.GCODE_TYPE_CUSTOM,
                "Bambu native pause M400 U1, resume by hand after the seconds above"
                if spec.pause_mode == "native" else "custom G-code: retract, lift 5 mm, G4 dwell, return"),
            "entries": [{"top_z_mm": p.top_z, "tier": p.tier, "joint_z_mm": p.z_top, "coupons": p.coupons}
                        for p in plate.pauses],
        },
        "geometries": {
            "ring": {"anchor": "tapered ring tip r_out %.1f, wall %.1f -> %.1f mm, %.1f mm tall" % (
                        spec.ring_r_out, spec.ring_wall_base, spec.ring_wall_tip, spec.tip_height),
                     "breakaway": "flat bottom",
                     "nominal_contact_mm2": round(contact_footprint_mm2("ring", spec), 3)},
            "grid": {"anchor": "%d ribs along X, %.1f wide, %.1f pitch, %.1f mm tall" % (
                        spec.rib_count, spec.rib_width, spec.rib_pitch, spec.tip_height),
                     "breakaway": "%d ribs along Y on the underside, same size; contact at the crossings only" % spec.rib_count,
                     "nominal_contact_mm2": round(contact_footprint_mm2("grid", spec), 3)},
        },
        "sign_convention": "gap_overlap_mm < 0: air gap of that size between anchor top and breakaway bottom; > 0: breakaway penetrates the anchor tip by that much",
        "coupons": coupons,
        "objects": objects,
        "notes": [
            "Open the .3mf as a PROJECT in Bambu Studio (File > Open Project). 'Import' drops objects to the bed and discards the pause.",
            "Do not Arrange, move, or drop-to-bed: the breakaway objects float at their joint Z on purpose.",
            "Check the layer height matches %s mm before slicing; the pause layers and the touchdown predictions assume it." % nso_3mf.num(spec.layer_height),
            "predicted_touchdown_layer_z_mm is the first breakaway layer the slicer should extrude. With whole layers, sub-layer gaps quantise: compare predicted_sliced_gap_mm across coupons before reading the physical result.",
            "touchdown_ambiguous = the breakaway's bottom face lies exactly on a slice plane; the slicer's tie-break decides which layer it starts on.",
            "identify_id is written per object so the G-code object labels (tools/grispr) can be checked against this map; whether Bambu keeps a supplied identify_id on load is unverified.",
        ],
    }


def mapping_text(m: dict) -> str:
    L: List[str] = []
    p = m["plate"]
    L.append("BREAKAWAY COUPON PLATE  (generated by %s v%s)" % (m["generator"], m["version"]))
    L.append("plate %.0f x %.0f mm, %d rows x %d cols, pitch %.0f mm (spacing %.0f mm), layer %s mm (first %s mm), print sequence %s" % (
        p["size_mm"][0], p["size_mm"][1], p["rows"], p["cols"], p["pitch_mm"], p["spacing_mm"],
        nso_3mf.num(p["layer_height_mm"]), nso_3mf.num(p["first_layer_height_mm"]), p["print_sequence"]))
    pz = m["pause"]
    L.append("pause: %s s, %s" % (nso_3mf.num(pz["seconds"]), pz["encoding"]))
    for e in pz["entries"]:
        L.append("  pause at layer z=%s  (tier %s, joint z=%s)  coupons %s" % (
            nso_3mf.num(e["top_z_mm"]), e["tier"], nso_3mf.num(e["joint_z_mm"]),
            ", ".join("C%02d" % i for i in e["coupons"])))
    L.append("")
    L.append("Row 1 is at the front of the plate (low Y), column 1 at the left (low X).")
    L.append("Notches: front edge (-Y) = column, left edge (-X) = row, on both halves of every coupon.")
    L.append("Sign: negative = air gap between anchor top and breakaway bottom, positive = the breakaway penetrates the anchor tip.")
    L.append("")
    hdr = "%-5s %-4s %-5s %-9s %-6s %-7s %-7s %-8s %-9s %-4s %-8s %s" % (
        "pos", "cpn", "geom", "gap/ovl", "pause", "joint_z", "bottom", "touchdn", "sliced", "amb", "contact", "objects (id:name)")
    L.append(hdr)
    L.append("-" * len(hdr))
    for c in m["coupons"]:
        L.append("%-5s C%02d  %-5s %+6.2f %-3s %-6s %-7s %-7s %-8s %-9s %-4s %-8s %d:%s  %d:%s" % (
            c["position"], c["coupon"], c["geometry"], c["gap_overlap_mm"], c["gap_kind"][:3],
            ("yes" if c["pause"] else "no"),
            nso_3mf.num(c["joint_z_mm"]), nso_3mf.num(c["breakaway_bottom_z_mm"]),
            nso_3mf.num(c["predicted_touchdown_layer_z_mm"]),
            ("%+.2f" % c["predicted_sliced_gap_mm"]).replace("-0.00", "+0.00"),
            ("YES" if c["touchdown_ambiguous"] else "-"),
            "%.1fmm2" % c["nominal_contact_mm2"],
            c["objects"]["anchor"]["object_id"], c["objects"]["anchor"]["name"],
            c["objects"]["breakaway"]["object_id"], c["objects"]["breakaway"]["name"]))
    L.append("")
    L.append("columns: joint_z = anchor top; bottom = breakaway lowest face; touchdn = predicted first extruded breakaway layer (print_z);")
    L.append("         sliced = predicted gap after layer quantisation; amb = bottom face exactly on a slice plane; contact = nominal weld footprint")
    L.append("")
    L.append("PLATE MAP (looking down, front at the bottom)")
    rows = {}
    for c in m["coupons"]:
        rows.setdefault(c["row"], {})[c["col"]] = c
    for r in sorted(rows, reverse=True):
        cells = []
        for col in range(1, p["cols"] + 1):
            c = rows[r].get(col)
            cells.append("[C%02d %s %+.2f %s]" % (c["coupon"], c["geometry"][:4], c["gap_overlap_mm"], "P" if c["pause"] else "-") if c else "[   empty          ]")
        L.append("r%d  %s" % (r, " ".join(cells)))
    L.append("    " + " ".join("       c%d          " % col for col in range(1, p["cols"] + 1)))
    L.append("")
    L.append("NOTES")
    for n in m["notes"]:
        L.append("- " + n)
    return "\n".join(L) + "\n"


# ============================================================================
# CLI
# ============================================================================

def parse_floats(s: str) -> Tuple[float, ...]:
    return tuple(float(x) for x in s.replace(";", ",").split(",") if x.strip())


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog="Full write-up: docs/BREAKAWAY-COUPONS.md")
    d = PlateSpec()
    ap.add_argument("--out-dir", default=os.path.join(ROOT, "out", "breakaway-coupons"))
    ap.add_argument("--stl-dir", default=None, help="also write one binary STL per object here")
    ap.add_argument("--basename", default="breakaway_coupon")
    ap.add_argument("--gaps", default=",".join("%g" % g for g in d.gaps), help="comma list, mm; negative = gap")
    ap.add_argument("--geometries", default=",".join(d.geometries), help="comma list from: %s" % ", ".join(GEOMETRIES))
    ap.add_argument("--pause-gaps", default=None, help="subset of --gaps to pair with a pause (default: all)")
    ap.add_argument("--no-pause-rows", action="store_true", help="skip the pause rows entirely")
    ap.add_argument("--pause-seconds", type=float, default=d.pause_seconds)
    ap.add_argument("--pause-mode", choices=PAUSE_MODES, default=d.pause_mode,
                    help="native: Bambu pause (M400 U1), resume by hand; dwell: custom G-code with a G4 timer")
    ap.add_argument("--layer-height", type=float, default=d.layer_height)
    ap.add_argument("--first-layer-height", type=float, default=d.first_layer_height)
    ap.add_argument("--plate-size", default="%g,%g" % d.plate_size, help="X,Y mm")
    ap.add_argument("--spacing", type=float, default=d.spacing)
    ap.add_argument("--cooling-profile", default=d.cooling_profile)
    ap.add_argument("--quiet", action="store_true")
    return ap


def spec_from_args(a: argparse.Namespace) -> PlateSpec:
    ps = parse_floats(a.plate_size)
    if len(ps) != 2:
        raise ValueError("--plate-size wants X,Y")
    return PlateSpec(
        gaps=parse_floats(a.gaps),
        geometries=tuple(g.strip() for g in a.geometries.split(",") if g.strip()),
        pause_rows=not a.no_pause_rows,
        pause_gaps=parse_floats(a.pause_gaps) if a.pause_gaps else None,
        pause_seconds=a.pause_seconds,
        pause_mode=a.pause_mode,
        layer_height=a.layer_height,
        first_layer_height=a.first_layer_height,
        plate_size=(ps[0], ps[1]),
        spacing=a.spacing,
        cooling_profile=a.cooling_profile,
    )


def generate(spec: PlateSpec, out_dir: str, basename: str = "breakaway_coupon",
             stl_dir: Optional[str] = None, log=print) -> Dict[str, str]:
    """Plan, build, verify, export. Raises RuntimeError listing every failing
    object if verification fails; nothing is written in that case."""
    plate = plan_plate(spec)
    build_objects(plate)
    failures = verify_objects(plate)
    if failures:
        raise RuntimeError("verify() failed on %d object(s); nothing exported:\n  " % len(failures) + "\n  ".join(failures))

    settings_text, source = project_settings(spec)
    objects = [nso_3mf.Object3MF(o.name, o.tris, o.identify_id) for o in plate.objects]
    layers = pause_layers(plate)

    os.makedirs(out_dir, exist_ok=True)
    path_3mf = os.path.join(out_dir, basename + "_plate.3mf")
    path_json = os.path.join(out_dir, basename + "_map.json")
    path_txt = os.path.join(out_dir, basename + "_map.txt")

    # The map goes inside the archive too, next to nso_profile.json's slot, so
    # the plate stays self-describing if the side files get separated from it.
    prelim = mapping_dict(plate, [])
    parts = nso_3mf.build_3mf(path_3mf, objects, settings_text, layers,
                              extra_parts={"Metadata/nso_coupon_map.json": json.dumps(prelim, indent=2) + "\n"},
                              application="Nest Optimizer breakaway coupons")
    m = mapping_dict(plate, parts)
    with open(path_json, "w", encoding="utf-8") as f:
        json.dump(m, f, indent=2)
        f.write("\n")
    with open(path_txt, "w", encoding="utf-8") as f:
        f.write(mapping_text(m))

    written = {"3mf": path_3mf, "json": path_json, "txt": path_txt}
    if stl_dir:
        os.makedirs(stl_dir, exist_ok=True)
        for o in plate.objects:
            p = os.path.join(stl_dir, "%02d_%s.stl" % (o.object_id, o.name))
            M.write_binary_stl(p, o.tris, b"nso breakaway coupon")
        written["stl_dir"] = stl_dir

    if log:
        log("verify: %d objects, %d parts, all watertight, outward-wound, no degenerate triangles" % (
            len(plate.objects), sum(len(o.parts) for o in plate.objects)))
        log("plate: %d coupons in %d rows x %d cols; tiers %s" % (
            len(plate.coupons), plate.rows, plate.cols,
            ", ".join("%s=%s" % (k, nso_3mf.num(v)) for k, v in plate.tiers.items())))
        for p in plate.pauses:
            log("pause: layer z=%s (tier %s) for coupons %s" % (
                nso_3mf.num(p.top_z), p.tier, ", ".join("C%02d" % i for i in p.coupons)))
        amb = [c.label for c in plate.coupons if c.ambiguous]
        if amb:
            log("note: %d coupon(s) have their bottom face exactly on a slice plane: %s" % (len(amb), ", ".join(amb)))
        log("settings: cooling from %s" % source)
        for k, v in written.items():
            log("wrote %s: %s" % (k, os.path.relpath(v, ROOT) if v.startswith(ROOT) else v))
    return written


def main(argv: Optional[Sequence[str]] = None) -> int:
    a = build_parser().parse_args(argv)
    try:
        spec = spec_from_args(a)
        generate(spec, a.out_dir, a.basename, a.stl_dir, log=(None if a.quiet else print))
    except (ValueError, RuntimeError) as e:
        print("error: %s" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
