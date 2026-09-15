"""Tests for tools/meshlib.py, tools/nso_3mf.py and tools/breakaway_coupons.py.

    python3 -m unittest discover -s tools/breakaway_test -p "test_*.py"
    npm run coupons:test

What is pinned here:
  * every primitive is closed, outward-wound and free of degenerate triangles,
    and verify() catches an inside-out shell;
  * the default plate plans 24 coupons / 48 objects, all of which pass
    verify(), with the anchor top minus breakaway bottom equal to the gap;
  * the layer-grid arithmetic (touchdown layer, ambiguity flag);
  * pause isolation: a pause never lands inside another coupon's joint window,
    and the planner refuses a plate where it would;
  * the .3mf: parts present, XML parses, 48 objects, pause entries at the
    planned Z with Bambu's attribute set, byte-identical on a second run;
  * the exported STLs pass tools/stl_watertight_check.py --odd --degen;
  * the embedded cooling values equal nso-cooling-profiles.js (needs Node);
  * the committed plate under fixtures/breakaway-coupons/ is what the current
    generator produces.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
ROOT = os.path.dirname(TOOLS)
sys.path.insert(0, TOOLS)

import breakaway_coupons as BC  # noqa: E402
import meshlib as M  # noqa: E402
import nso_3mf  # noqa: E402

FIXTURE_DIR = os.path.join(ROOT, "fixtures", "breakaway-coupons")
NS = {"m": "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"}


def has_node() -> bool:
    return shutil.which("node") is not None


class MeshlibTests(unittest.TestCase):
    def assert_clean(self, tris, volume=None, places=3):
        rep = M.verify(tris)
        self.assertTrue(rep["ok"], M.describe_failure(rep))
        if volume is not None:
            self.assertAlmostEqual(rep["signed_volume"], volume, places=places)

    def test_box(self):
        self.assert_clean(M.box(0, 2, 0, 3, 0, 4), 24.0)

    def test_cylinder(self):
        import math
        tris = M.cylinder(1, 1, 0, 3, 2, 256)
        rep = M.verify(tris)
        self.assertTrue(rep["ok"])
        self.assertAlmostEqual(rep["signed_volume"], math.pi * 4 * 3, delta=0.02)

    def test_tapered_ring(self):
        import math
        tris = M.tapered_ring(0, 0, 0, 1, 5.0, 4.8, 4.2, 4.4, 256)
        rep = M.verify(tris)
        self.assertTrue(rep["ok"])
        # mean annulus: pi * (4.9^2 - 4.3^2)
        self.assertAlmostEqual(rep["signed_volume"], math.pi * (4.9 ** 2 - 4.3 ** 2), delta=0.02)

    def test_notched_prism(self):
        spec = BC.PlateSpec()
        poly = BC.notched_square(16.0, 6, 4, spec)
        tris = M.extrude_polygon(poly, 0, 5)
        area = M.polygon_area(poly)
        self.assertGreater(area, 0)
        self.assert_clean(tris, area * 5)
        # 10 notches removed: 10 * 1.0 * 0.8
        self.assertAlmostEqual(area, 256 - 10 * 0.8, places=6)

    def test_extrude_accepts_clockwise(self):
        poly = [(0, 0), (0, 1), (1, 1), (1, 0)]
        self.assert_clean(M.extrude_polygon(poly, 0, 1), 1.0)

    def test_inverted_shell_fails(self):
        inv = [(a, c, b) for a, b, c in M.box(0, 1, 0, 1, 0, 1)]
        rep = M.verify(inv)
        self.assertFalse(rep["ok"])
        self.assertLess(rep["signed_volume"], 0)

    def test_open_shell_fails(self):
        rep = M.verify(M.box(0, 1, 0, 1, 0, 1)[2:])
        self.assertFalse(rep["ok"])
        self.assertGreater(rep["odd_edges"], 0)

    def test_degenerate_counted(self):
        tris = M.box(0, 1, 0, 1, 0, 1) + [((0, 0, 0), (1, 0, 0), (2, 0, 0))]
        rep = M.verify(tris)
        self.assertEqual(rep["degenerate_tris"], 1)
        self.assertFalse(rep["ok"])

    def test_overlapping_shells_pass_by_design(self):
        # The volumetric-overlap union: two closed shells, every edge still 2-valent.
        tris = M.concat(M.box(0, 2, 0, 2, 0, 2), M.box(1, 3, 1, 3, 1, 3))
        self.assertTrue(M.verify(tris)["ok"])

    def test_too_many_notches_rejected(self):
        with self.assertRaises(ValueError):
            BC.notched_square(14.0, 9, 0, BC.PlateSpec())


class LayerGridTests(unittest.TestCase):
    def setUp(self):
        self.spec = BC.PlateSpec()

    def test_touchdown_quantises(self):
        cases = {6.20: (6.4, False), 6.15: (6.4, False), 6.10: (6.4, True),
                 6.05: (6.2, False), 6.00: (6.2, False), 5.98: (6.2, False)}
        for bottom, want in cases.items():
            self.assertEqual(BC.touchdown(bottom, self.spec), want, bottom)

    def test_first_layer(self):
        self.assertEqual(BC.touchdown(0.0, self.spec), (0.2, False))
        thin = BC.PlateSpec(first_layer_height=0.1, layer_height=0.1)
        self.assertEqual(BC.touchdown(0.0, thin), (0.1, False))
        # bottom face exactly on the 6.0-6.1 slice plane: flagged, next layer wins
        self.assertEqual(BC.touchdown(6.05, thin), (6.2, True))

    def test_alignment(self):
        self.assertTrue(BC.is_layer_aligned(6.0, self.spec))
        self.assertTrue(BC.is_layer_aligned(0.2, self.spec))
        self.assertFalse(BC.is_layer_aligned(6.1, self.spec))
        self.assertFalse(BC.is_layer_aligned(0.0, self.spec))

    def test_unaligned_tier_rejected(self):
        with self.assertRaises(ValueError):
            BC.plan_plate(BC.PlateSpec(anchor_top_nopause=6.1))


class PlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec = BC.PlateSpec()
        cls.plate = BC.plan_plate(cls.spec)
        BC.build_objects(cls.plate)
        cls.failures = BC.verify_objects(cls.plate)

    def test_counts(self):
        self.assertEqual(len(self.plate.coupons), 24)
        self.assertEqual(len(self.plate.objects), 48)
        self.assertEqual((self.plate.rows, self.plate.cols), (4, 6))

    def test_every_object_and_part_verifies(self):
        self.assertEqual(self.failures, [])
        for o in self.plate.objects:
            self.assertTrue(o.report["ok"], o.name)
            self.assertGreater(o.report["signed_volume"], 0, o.name)

    def test_sweep_is_complete(self):
        combos = {(c.geometry, c.gap, c.pause) for c in self.plate.coupons}
        want = {(g, gap, p) for g in BC.GEOMETRIES for gap in self.spec.gaps for p in (False, True)}
        self.assertEqual(combos, want)

    def test_coincidence(self):
        for c in self.plate.coupons:
            lo_a, hi_a = M.bbox(c.anchor.tris)
            lo_b, hi_b = M.bbox(c.breakaway.tris)
            self.assertAlmostEqual(lo_a[2], 0.0, places=6, msg=c.label)
            self.assertAlmostEqual(hi_a[2], c.z_top, places=6, msg=c.label)
            self.assertAlmostEqual(lo_b[2], c.bottom, places=6, msg=c.label)
            self.assertAlmostEqual(hi_a[2] - lo_b[2], c.gap, places=6, msg=c.label)
            self.assertAlmostEqual(lo_b[2], c.z_top - c.gap, places=6, msg=c.label)

    def test_footprints_and_spacing(self):
        s = self.spec
        for c in self.plate.coupons:
            lo, hi = M.bbox(c.anchor.tris)
            self.assertAlmostEqual(hi[0] - lo[0], s.coupon_size, places=6)
            self.assertAlmostEqual(hi[1] - lo[1], s.coupon_size, places=6)
            lo, hi = M.bbox(c.breakaway.tris)
            self.assertAlmostEqual(hi[0] - lo[0], s.breakaway_size, places=6)
        xs = sorted({c.x for c in self.plate.coupons})
        ys = sorted({c.y for c in self.plate.coupons})
        for seq in (xs, ys):
            for a, b in zip(seq, seq[1:]):
                self.assertAlmostEqual(b - a, s.pitch(), places=6)
        # centred on the plate
        self.assertAlmostEqual((xs[0] + xs[-1]) / 2, s.plate_size[0] / 2, places=6)
        self.assertAlmostEqual((ys[0] + ys[-1]) / 2, s.plate_size[1] / 2, places=6)

    def test_tiers_and_pauses(self):
        self.assertEqual(self.plate.tiers, {"N": 6.0, "P1": 9.0, "P2": 12.0})
        self.assertEqual([(p.top_z, p.tier) for p in self.plate.pauses], [(9.2, "P1"), (12.4, "P2")])
        for c in self.plate.coupons:
            if not c.pause:
                self.assertEqual(c.tier, "N")
            self.assertEqual(c.z_top, self.plate.tiers[c.tier])
        # every pause coupon's touchdown is exactly its pause layer
        for p in self.plate.pauses:
            for i in p.coupons:
                c = self.plate.coupons[i - 1]
                self.assertTrue(c.pause)
                self.assertAlmostEqual(c.touchdown_z, p.top_z, places=6)

    def test_pause_isolation_holds_and_is_enforced(self):
        BC.check_pause_isolation(self.plate)          # must not raise
        # Move a pause into a no-pause coupon's joint window -> refused.
        import copy
        bad = copy.deepcopy(self.plate)
        bad.pauses[0].top_z = 6.2
        with self.assertRaises(ValueError):
            BC.check_pause_isolation(bad)
        # A pause coupon whose pause is not at its touchdown -> refused.
        bad = copy.deepcopy(self.plate)
        bad.pauses[1].top_z = 12.6
        with self.assertRaises(ValueError):
            BC.check_pause_isolation(bad)

    def test_ambiguous_flags(self):
        amb = sorted(c.label for c in self.plate.coupons if c.ambiguous)
        self.assertEqual(amb, ["C03_ring_g-0.10_N", "C09_grid_g-0.10_N",
                               "C15_ring_g-0.10_P", "C21_grid_g-0.10_P"])

    def test_grid_ribs_cross(self):
        c = next(c for c in self.plate.coupons if c.geometry == "grid" and not c.pause and c.gap == 0.0)
        ax = [p for p in c.anchor.parts if p.name.startswith("rib_x")]
        by = [p for p in c.breakaway.parts if p.name.startswith("rib_y")]
        self.assertEqual((len(ax), len(by)), (4, 4))
        for a in ax:
            lo, hi = M.bbox(a.tris)
            self.assertAlmostEqual(hi[2], c.z_top, places=6)
            self.assertAlmostEqual(hi[0] - lo[0], self.spec.rib_span, places=6)
            self.assertAlmostEqual(hi[1] - lo[1], self.spec.rib_width, places=6)
        for b in by:
            lo, hi = M.bbox(b.tris)
            self.assertAlmostEqual(lo[2], c.bottom, places=6)
            self.assertAlmostEqual(hi[1] - lo[1], self.spec.rib_span, places=6)
            self.assertAlmostEqual(hi[0] - lo[0], self.spec.rib_width, places=6)

    def test_ring_tip_at_joint(self):
        c = next(c for c in self.plate.coupons if c.geometry == "ring" and c.pause and c.gap == -0.2)
        ring = next(p for p in c.anchor.parts if p.name == "ring_tip")
        lo, hi = M.bbox(ring.tris)
        self.assertAlmostEqual(hi[2], c.z_top, places=6)
        self.assertAlmostEqual(hi[0] - lo[0], 2 * self.spec.ring_r_out, places=3)

    def test_pause_gap_subset_and_no_pause_rows(self):
        p = BC.plan_plate(BC.PlateSpec(pause_gaps=(-0.20,)))
        self.assertEqual(len(p.coupons), 12 + 2)
        self.assertEqual(p.tiers, {"N": 6.0, "P1": 9.0})
        self.assertEqual([(q.top_z, q.coupons) for q in p.pauses], [(9.4, [13, 14])])
        p = BC.plan_plate(BC.PlateSpec(pause_rows=False))
        self.assertEqual(len(p.coupons), 12)
        self.assertEqual(p.pauses, [])
        self.assertEqual(p.tiers, {"N": 6.0})

    def test_off_plate_rejected(self):
        with self.assertRaises(ValueError):
            BC.plan_plate(BC.PlateSpec(plate_size=(100.0, 100.0)))


class ExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="nso-coupons-")
        cls.spec = BC.PlateSpec()
        cls.written = BC.generate(cls.spec, cls.tmp, stl_dir=os.path.join(cls.tmp, "stl"), log=None)
        with open(cls.written["json"], encoding="utf-8") as f:
            cls.map = json.load(f)
        cls.zip = zipfile.ZipFile(cls.written["3mf"])

    @classmethod
    def tearDownClass(cls):
        cls.zip.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_parts_present(self):
        names = self.zip.namelist()
        for part in ("[Content_Types].xml", "_rels/.rels", nso_3mf.PART_MODEL,
                     nso_3mf.PART_PROJECT_SETTINGS, nso_3mf.PART_MODEL_SETTINGS,
                     nso_3mf.PART_CUSTOM_GCODE, "Metadata/nso_coupon_map.json"):
            self.assertIn(part, names)
        self.assertEqual(self.map["plate"]["parts_in_3mf"], names)
        self.assertIsNone(self.zip.testzip())

    def test_model_xml(self):
        root = ET.fromstring(self.zip.read(nso_3mf.PART_MODEL))
        objs = root.findall("./m:resources/m:object", NS)
        items = root.findall("./m:build/m:item", NS)
        self.assertEqual(len(objs), 48)
        self.assertEqual(len(items), 48)
        for it in items:
            self.assertEqual(it.get("transform"), "1 0 0 0 1 0 0 0 1 0 0 0")
        # per-object z range in the file matches the map (plate coordinates, no transform)
        zr = {}
        for o in objs:
            zs = [float(v.get("z")) for v in o.findall("./m:mesh/m:vertices/m:vertex", NS)]
            zr[int(o.get("id"))] = (min(zs), max(zs))
        for c in self.map["coupons"]:
            a, b = zr[c["objects"]["anchor"]["object_id"]], zr[c["objects"]["breakaway"]["object_id"]]
            self.assertAlmostEqual(a[1], c["joint_z_mm"], places=5, msg=c["label"])
            self.assertAlmostEqual(b[0], c["breakaway_bottom_z_mm"], places=5, msg=c["label"])
            self.assertAlmostEqual(a[1] - b[0], c["gap_overlap_mm"], places=5, msg=c["label"])

    def test_model_settings(self):
        root = ET.fromstring(self.zip.read(nso_3mf.PART_MODEL_SETTINGS))
        names = {int(o.get("id")): o.find("./metadata[@key='name']").get("value") for o in root.findall("./object")}
        self.assertEqual(len(names), 48)
        inst = root.findall("./plate/model_instance")
        self.assertEqual(len(inst), 48)
        ids = {}
        for mi in inst:
            kv = {m.get("key"): m.get("value") for m in mi.findall("./metadata")}
            ids[int(kv["object_id"])] = int(kv["identify_id"])
        for o in self.map["objects"]:
            self.assertEqual(names[o["object_id"]], o["name"])
            self.assertEqual(ids[o["object_id"]], o["identify_id"])
        self.assertEqual(len(set(ids.values())), 48)

    def test_custom_gcode_pause_entries(self):
        root = ET.fromstring(self.zip.read(nso_3mf.PART_CUSTOM_GCODE))
        self.assertEqual(root.tag, "custom_gcodes_per_layer")
        plate = root.find("./plate")
        self.assertEqual(plate.find("./plate_info").get("id"), "1")
        self.assertEqual(plate.find("./mode").get("value"), "SingleExtruder")
        layers = plate.findall("./layer")
        self.assertEqual([(L.get("top_z"), L.get("type")) for L in layers], [("9.2", "1"), ("12.4", "1")])
        for L in layers:
            self.assertEqual(sorted(L.attrib), ["color", "extra", "extruder", "top_z", "type"])
            self.assertIn("22 s", L.get("extra"))
        self.assertEqual([e["top_z_mm"] for e in self.map["pause"]["entries"]], [9.2, 12.4])

    def test_project_settings_shapes(self):
        ps = json.loads(self.zip.read(nso_3mf.PART_PROJECT_SETTINGS))
        for k, v in BC.COOLING_DEFAULT_VALUES:
            self.assertEqual(ps[k], [v], k)          # filament keys: 1-element string arrays
        self.assertEqual(ps["layer_height"], "0.2")  # print keys: plain strings
        self.assertEqual(ps["initial_layer_print_height"], "0.2")
        self.assertEqual(ps["print_sequence"], "by layer")

    def test_map_files(self):
        self.assertEqual(len(self.map["coupons"]), 24)
        self.assertEqual(len(self.map["objects"]), 48)
        for o in self.map["objects"]:
            self.assertTrue(o["verify"]["ok"], o["name"])
        with open(self.written["txt"], encoding="utf-8") as f:
            txt = f.read()
        for c in self.map["coupons"]:
            self.assertIn(c["position"], txt)
            self.assertIn(c["objects"]["anchor"]["name"], txt)
        embedded = json.loads(self.zip.read("Metadata/nso_coupon_map.json"))
        self.assertEqual(embedded["coupons"], self.map["coupons"])
        c = next(c for c in self.map["coupons"] if c["label"] == "C01_ring_g-0.20_N")
        self.assertEqual(c["predicted_sliced_gap_mm"], -0.2)
        self.assertEqual(c["notches"], {"front_edge_minus_y": 1, "left_edge_minus_x": 1})
        c = next(c for c in self.map["coupons"] if c["label"] == "C06_ring_g+0.02_N")
        self.assertEqual(c["predicted_sliced_gap_mm"], 0.0)
        self.assertEqual(c["notches"], {"front_edge_minus_y": 6, "left_edge_minus_x": 1})

    def test_stls_pass_repo_checker(self):
        stls = sorted(os.listdir(self.written["stl_dir"]))
        self.assertEqual(len(stls), 48)
        checker = os.path.join(TOOLS, "stl_watertight_check.py")
        for name in stls:
            out = subprocess.run([sys.executable, checker, os.path.join(self.written["stl_dir"], name), "--odd", "--degen"],
                                 capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, name + "\n" + out.stdout)

    def test_deterministic(self):
        again = tempfile.mkdtemp(prefix="nso-coupons-2-")
        try:
            w = BC.generate(self.spec, again, log=None)
            for k in ("3mf", "json", "txt"):
                with open(self.written[k], "rb") as a, open(w[k], "rb") as b:
                    self.assertEqual(a.read(), b.read(), k)
        finally:
            shutil.rmtree(again, ignore_errors=True)

    def test_dwell_mode(self):
        tmp = tempfile.mkdtemp(prefix="nso-coupons-dwell-")
        try:
            w = BC.generate(BC.PlateSpec(pause_mode="dwell", pause_seconds=25), tmp, log=None)
            with zipfile.ZipFile(w["3mf"]) as z:
                root = ET.fromstring(z.read(nso_3mf.PART_CUSTOM_GCODE))
            layers = root.findall("./plate/layer")
            self.assertEqual([L.get("type") for L in layers], ["4", "4"])
            for L in layers:
                self.assertIn("G4 S25", L.get("extra"))
                self.assertIn("M400", L.get("extra"))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_no_pause_rows_omits_gcode_part(self):
        tmp = tempfile.mkdtemp(prefix="nso-coupons-np-")
        try:
            w = BC.generate(BC.PlateSpec(pause_rows=False), tmp, log=None)
            with zipfile.ZipFile(w["3mf"]) as z:
                self.assertNotIn(nso_3mf.PART_CUSTOM_GCODE, z.namelist())
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_verify_failure_blocks_export(self):
        tmp = tempfile.mkdtemp(prefix="nso-coupons-bad-")
        try:
            real = BC.build_breakaway_parts

            def broken(c, spec):
                parts = real(c, spec)
                parts[-1].tris = parts[-1].tris[2:]      # open the body
                return parts
            BC.build_breakaway_parts = broken
            with self.assertRaises(RuntimeError) as cm:
                BC.generate(BC.PlateSpec(), tmp, log=None)
            self.assertIn("nothing exported", str(cm.exception))
            self.assertIn("odd edges", str(cm.exception))
            self.assertEqual(os.listdir(tmp), [])
        finally:
            BC.build_breakaway_parts = real
            shutil.rmtree(tmp, ignore_errors=True)


class CoolingTests(unittest.TestCase):
    @unittest.skipUnless(has_node(), "node not available")
    def test_embedded_defaults_match_js(self):
        js = os.path.join(ROOT, "nso-cooling-profiles.js")
        out = subprocess.run(["node", "-e",
                              "const P=require(process.argv[1]);"
                              "process.stdout.write(P.serializeProjectSettings(P.resolveValues('default')))", js],
                             capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(out.stdout), {k: [v] for k, v in BC.COOLING_DEFAULT_VALUES})
        self.assertEqual([k for k, _ in BC.COOLING_DEFAULT_VALUES], list(json.loads(out.stdout).keys()))

    def test_unknown_profile_rejected(self):
        with self.assertRaises(ValueError):
            BC.cooling_values("no-such-profile")


class CommittedPlateTests(unittest.TestCase):
    """The plate under fixtures/breakaway-coupons/ is a generated artifact.
    Regenerating with defaults must reproduce it byte for byte; if this fails,
    rerun `npm run coupons:plate` and commit the result."""

    @unittest.skipUnless(os.path.isdir(FIXTURE_DIR), "no committed plate")
    def test_committed_plate_is_current(self):
        tmp = tempfile.mkdtemp(prefix="nso-coupons-fx-")
        try:
            w = BC.generate(BC.PlateSpec(), tmp, log=None)
            for k, name in (("3mf", "breakaway_coupon_plate.3mf"), ("json", "breakaway_coupon_map.json"),
                            ("txt", "breakaway_coupon_map.txt")):
                with open(w[k], "rb") as a, open(os.path.join(FIXTURE_DIR, name), "rb") as b:
                    self.assertEqual(a.read(), b.read(), name + " is stale: rerun npm run coupons:plate")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
