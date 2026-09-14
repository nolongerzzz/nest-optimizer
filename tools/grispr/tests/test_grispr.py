"""Test suite for Grispr.

The central invariant, asserted by `assert_no_fan_leak`, is stronger than
"injection happened in the right place": for every line of the original file
that lies outside a targeted object's block, the part-cooling fan state in the
modified file must equal the state the original file would have had at that same
line. That is what "state does not leak between objects" actually means, and it
is checked line-by-line rather than only at block boundaries.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from typing import Dict, List, Optional, Sequence, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import fixtures  # noqa: E402
import grispr  # noqa: E402

SCRIPT = os.path.join(ROOT, "grispr.py")


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def run_cli(args: Sequence[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, SCRIPT, *args],
        capture_output=True,
        text=True,
    )


def fan_timeline(text: str, fan_index: int = 1) -> List[Optional[int]]:
    lines = grispr.split_lines(text)
    return grispr.original_fan_timeline(lines, fan_index)


def align_to_original(
    original: Sequence[str], modified: Sequence[str]
) -> Dict[int, int]:
    """Map each original line index to its index in the modified file.

    Lines Grispr inserted carry the sentinel and are skipped. Any other
    divergence means the tool rewrote content it should not have touched, so
    this raises rather than papering over it.
    """
    suppressed = re.compile(
        rf"^\s*;\s*{re.escape(grispr.SENTINEL)}\s+suppressed:\s?"
    )

    def is_insertion(text: str) -> bool:
        return grispr.SENTINEL in text and not suppressed.match(grispr.strip_eol(text))

    mapping: Dict[int, int] = {}
    j = 0
    for i, line in enumerate(original):
        while j < len(modified) and is_insertion(modified[j]):
            j += 1
        if j >= len(modified):
            raise AssertionError(
                f"original line {i + 1} ({line!r}) has no counterpart in the output"
            )
        match = suppressed.match(grispr.strip_eol(modified[j]))
        if match:
            # A suppressed line still corresponds to this original line; its
            # original text must be recoverable verbatim from the comment.
            recovered = grispr.strip_eol(modified[j])[match.end():]
            if recovered != grispr.strip_eol(line):
                raise AssertionError(
                    f"original line {i + 1} was suppressed but not preserved: "
                    f"{line!r} -> {recovered!r}"
                )
        elif modified[j] != line:
            raise AssertionError(
                f"original line {i + 1} was altered: {line!r} -> {modified[j]!r}"
            )
        mapping[i] = j
        j += 1
    while j < len(modified) and is_insertion(modified[j]):
        j += 1
    if j != len(modified):
        raise AssertionError(f"unexpected extra output line: {modified[j]!r}")
    return mapping


class GrisprTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="grispr-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def write(self, name: str, text: str) -> str:
        path = os.path.join(self.tmp, name)
        with open(path, "w", newline="") as handle:
            handle.write(text)
        return path

    def read(self, path: str) -> str:
        with open(path, newline="") as handle:
            return handle.read()

    def assert_no_fan_leak(
        self,
        original_text: str,
        modified_text: str,
        targets: Sequence[int],
        fan_index: int = 1,
        layer_range: Optional[Tuple[int, int]] = None,
    ) -> None:
        """Fan state outside targeted blocks must match the original, line by line.

        "No command issued yet" (None) and an explicit S0 are the same physical
        state - the managed fan is off either way, since the printer's power-on
        default for it is off - so both normalise to 0 before comparison. Every
        other value must match exactly.
        """
        original = grispr.split_lines(original_text)
        modified = grispr.split_lines(modified_text)
        mapping = align_to_original(original, modified)

        doc = grispr.parse_gcode(original)
        targeted_ranges = [
            (b.start_index, b.stop_index)
            for b in doc.blocks
            if b.object_id in targets
            and (
                layer_range is None
                or (b.layer is not None and layer_range[0] <= b.layer <= layer_range[1])
            )
        ]

        def inside_target(index: int) -> bool:
            return any(start <= index <= stop for start, stop in targeted_ranges)

        before = grispr.original_fan_timeline(original, fan_index)
        after = grispr.original_fan_timeline(modified, fan_index)

        def effective(state: Optional[int]) -> int:
            return 0 if state is None else state

        for i in range(len(original)):
            if inside_target(i):
                continue
            expected = effective(before[i])
            actual = effective(after[mapping[i]])
            self.assertEqual(
                actual,
                expected,
                msg=(
                    f"fan state leaked at original line {i + 1} "
                    f"({grispr.strip_eol(original[i])!r}): "
                    f"expected {expected}, got {actual}"
                ),
            )

    def assert_unchanged(self, path: str, expected_text: str) -> None:
        self.assertEqual(
            self.read(path), expected_text, "input file must not be modified"
        )

    def assert_no_temp_files(self) -> None:
        leftovers = [n for n in os.listdir(self.tmp) if n.startswith(".grispr-")]
        self.assertEqual(leftovers, [], f"temp files left behind: {leftovers}")


# ---------------------------------------------------------------------------
# Task 1 - parse and locate
# ---------------------------------------------------------------------------


class TestParsing(GrisprTestCase):
    def test_single_object_three_layers(self) -> None:
        doc = grispr.parse_gcode(grispr.split_lines(fixtures.single_object()))
        self.assertEqual(len(doc.blocks), 3)
        self.assertEqual({b.object_id for b in doc.blocks}, {1})
        self.assertEqual([b.layer for b in doc.blocks], [1, 2, 3])

    def test_block_ranges_point_at_the_markers(self) -> None:
        text = fixtures.two_objects()
        lines = grispr.split_lines(text)
        doc = grispr.parse_gcode(lines)
        self.assertEqual(len(doc.blocks), 6)
        for block in doc.blocks:
            self.assertRegex(
                lines[block.start_index],
                rf"start printing object, unique label id: {block.object_id}$",
            )
            self.assertRegex(
                lines[block.stop_index],
                rf"stop printing object, unique label id: {block.object_id}$",
            )
            self.assertLess(block.start_index, block.stop_index)

    def test_blocks_do_not_overlap_and_are_ordered(self) -> None:
        doc = grispr.parse_gcode(grispr.split_lines(fixtures.interleaved_three()))
        previous_stop = -1
        for block in doc.blocks:
            self.assertGreater(block.start_index, previous_stop)
            previous_stop = block.stop_index

    def test_interleaved_layer_yields_multiple_blocks_per_object(self) -> None:
        """Layer 2 prints 1,2,3,1,2 - the one-block-per-object assumption fails."""
        doc = grispr.parse_gcode(grispr.split_lines(fixtures.interleaved_three()))
        self.assertEqual(len(doc.blocks), 11)
        layer2 = [b.object_id for b in doc.blocks if b.layer == 2]
        self.assertEqual(layer2, [1, 2, 3, 1, 2])
        self.assertEqual(layer2.count(1), 2)
        self.assertEqual(layer2.count(2), 2)

    def test_layer_assignment_survives_interleave(self) -> None:
        doc = grispr.parse_gcode(grispr.split_lines(fixtures.interleaved_three()))
        self.assertEqual([b.object_id for b in doc.blocks if b.layer == 3], [3, 1, 2])

    def test_object_id_markers_counted(self) -> None:
        doc = grispr.parse_gcode(grispr.split_lines(fixtures.two_objects()))
        self.assertEqual(doc.object_id_markers, 6)

    def test_layer_manifest_parsed(self) -> None:
        doc = grispr.parse_gcode(grispr.split_lines(fixtures.interleaved_three()))
        self.assertEqual(doc.layer_manifest[2], [1, 2, 3])

    def test_manifest_mismatch_is_warned_not_swallowed(self) -> None:
        doc = grispr.parse_gcode(grispr.split_lines(fixtures.manifest_mismatch()))
        self.assertTrue(
            any("9" in w and "no print block" in w for w in doc.warnings),
            f"expected a manifest mismatch warning, got {doc.warnings}",
        )

    def test_missing_layer_markers_is_warned(self) -> None:
        doc = grispr.parse_gcode(grispr.split_lines(fixtures.no_layer_markers()))
        self.assertEqual(len(doc.blocks), 2)
        self.assertTrue(all(b.layer is None for b in doc.blocks))
        self.assertTrue(any("no layer markers" in w for w in doc.warnings))

    def test_marker_inside_a_longer_comment_is_not_matched(self) -> None:
        """The patterns are anchored; prose mentioning the marker must not match."""
        text = (
            "; this file will start printing object, unique label id: 1 later on\n"
            + fixtures.single_object()
        )
        doc = grispr.parse_gcode(grispr.split_lines(text))
        self.assertEqual(len(doc.blocks), 3)


class TestFanParsing(GrisprTestCase):
    def test_command_forms(self) -> None:
        cases = [
            ("M106 S255", (1, 255)),
            ("M106 P1 S128", (1, 128)),
            ("M106 P2 S80", (2, 80)),
            ("M106", (1, 255)),
            ("M107", (1, 0)),
            ("M107 P2", (2, 0)),
            ("M106 S255.0", (1, 255)),
            ("m106 s64", (1, 64)),
            ("  M106 S30 ; ramp up", (1, 30)),
            ("G1 X10 Y10", None),
            ("; M106 S255 inside a comment", None),
            ("M1060 S255", None),
            ("", None),
        ]
        for line, expected in cases:
            with self.subTest(line=line):
                self.assertEqual(grispr.parse_fan_command(line), expected)

    def test_timeline_tracks_only_the_managed_fan(self) -> None:
        text = fixtures.aux_fan()
        part = fan_timeline(text, 1)
        aux = fan_timeline(text, 2)
        self.assertEqual(part[-1], 0)  # footer M107
        self.assertEqual(aux[-1], 80)  # untouched by the footer M107


# ---------------------------------------------------------------------------
# Task 2 - inject and restore
# ---------------------------------------------------------------------------


class TestInjection(GrisprTestCase):
    def test_injects_after_every_start_marker_for_the_target(self) -> None:
        text = fixtures.interleaved_three()
        path = self.write("a.gcode", text)
        result = run_cli(["--object", "2=255", path])
        self.assertEqual(result.returncode, 0, result.stderr)

        modified = grispr.split_lines(self.read(path))
        doc = grispr.parse_gcode(grispr.split_lines(text))
        expected = len([b for b in doc.blocks if b.object_id == 2])
        forced = [
            l for l in modified if grispr.SENTINEL in l and "force obj=2" in l
        ]
        self.assertEqual(len(forced), expected)
        self.assertEqual(expected, 4)  # object 2 prints on 3 layers, twice on layer 2

    def test_forced_line_follows_its_start_marker_immediately(self) -> None:
        path = self.write("a.gcode", fixtures.interleaved_three())
        self.assertEqual(run_cli(["--object", "1=255", path]).returncode, 0)
        modified = grispr.split_lines(self.read(path))
        for i, line in enumerate(modified):
            if grispr.SENTINEL in line and "force obj=1" in line:
                self.assertRegex(
                    modified[i - 1],
                    r"start printing object, unique label id: 1$",
                    "forced command is not directly after its start marker",
                )

    def test_restore_line_follows_its_stop_marker_immediately(self) -> None:
        path = self.write("a.gcode", fixtures.interleaved_with_slicer_fan())
        self.assertEqual(run_cli(["--object", "1=255", path]).returncode, 0)
        modified = grispr.split_lines(self.read(path))
        restores = 0
        for i, line in enumerate(modified):
            if grispr.SENTINEL in line and "restore obj=1" in line:
                restores += 1
                self.assertRegex(
                    modified[i - 1], r"stop printing object, unique label id: 1$"
                )
        self.assertGreater(restores, 0)

    def test_restore_value_is_the_actual_prior_state_not_a_constant(self) -> None:
        """Layers carry different ambient fan speeds; each restore must differ."""
        text = fixtures.interleaved_with_slicer_fan()
        path = self.write("a.gcode", text)
        self.assertEqual(run_cli(["--object", "1=255", path]).returncode, 0)
        restores = [
            grispr.strip_eol(l)
            for l in grispr.split_lines(self.read(path))
            if grispr.SENTINEL in l and "restore obj=1" in l
        ]
        values = [grispr.parse_fan_command(l)[1] for l in restores]
        # layer 1 ambient S102, layer 2 still S102, layer 3 ambient S153
        self.assertEqual(values, [102, 102, 153])

    def test_restore_accounts_for_slicer_fan_commands_inside_the_block(self) -> None:
        """Object 2's own overhang M106 S255 is the state to return to, not S102."""
        text = fixtures.interleaved_with_slicer_fan()
        path = self.write("a.gcode", text)
        result = run_cli(["--object", "2=0", path])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("no restore needed", result.stdout)
        self.assert_no_fan_leak(text, self.read(path), [2])

    def test_no_leak_interleaved_single_target(self) -> None:
        for target in (1, 2, 3):
            with self.subTest(target=target):
                text = fixtures.interleaved_with_slicer_fan()
                path = self.write(f"t{target}.gcode", text)
                result = run_cli(["--object", f"{target}=255", path])
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assert_no_fan_leak(text, self.read(path), [target])

    def test_no_leak_interleaved_multiple_targets(self) -> None:
        text = fixtures.interleaved_with_slicer_fan()
        path = self.write("multi.gcode", text)
        result = run_cli(["--object", "1=255", "--object", "3=0", path])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_no_fan_leak(text, self.read(path), [1, 3])

    def test_no_leak_across_every_well_formed_fixture(self) -> None:
        for name, builder in fixtures.WELL_FORMED.items():
            text = builder()
            doc = grispr.parse_gcode(grispr.split_lines(text))
            for target in sorted({b.object_id for b in doc.blocks}):
                with self.subTest(fixture=name, target=target):
                    path = self.write(f"{name}-{target}.gcode", text)
                    result = run_cli(["--object", f"{target}=200", path])
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assert_no_fan_leak(text, self.read(path), [target])

    def test_non_target_lines_are_byte_identical(self) -> None:
        text = fixtures.interleaved_three()
        path = self.write("a.gcode", text)
        self.assertEqual(run_cli(["--object", "2=255", path]).returncode, 0)
        align_to_original(
            grispr.split_lines(text), grispr.split_lines(self.read(path))
        )  # raises if any original line was altered or dropped

    def test_forced_value_is_active_at_the_first_move_of_the_block(self) -> None:
        text = fixtures.interleaved_with_slicer_fan()
        path = self.write("a.gcode", text)
        self.assertEqual(run_cli(["--object", "3=64", path]).returncode, 0)
        modified = grispr.split_lines(self.read(path))
        timeline = grispr.original_fan_timeline(modified, 1)
        doc = grispr.parse_gcode(modified)
        for block in doc.blocks:
            if block.object_id != 3:
                continue
            first_move = block.start_index
            while not grispr.code_part(modified[first_move]).strip():
                first_move += 1
            self.assertEqual(timeline[first_move], 64)

    def test_percentage_and_clamping(self) -> None:
        self.assertEqual(grispr.parse_fan_value("60%"), 153)
        self.assertEqual(grispr.parse_fan_value("100%"), 255)
        self.assertEqual(grispr.parse_fan_value("0"), 0)
        self.assertEqual(grispr.parse_fan_value("255"), 255)
        for bad in ("256", "-1", "abc", "120%", "-5%"):
            with self.subTest(value=bad):
                with self.assertRaises(grispr.GrisprError):
                    grispr.parse_fan_value(bad)

    def test_aux_fan_index_leaves_part_cooling_alone(self) -> None:
        text = fixtures.aux_fan()
        path = self.write("aux.gcode", text)
        result = run_cli(["--fan-index", "2", "--object", "1=200", path])
        self.assertEqual(result.returncode, 0, result.stderr)
        modified_text = self.read(path)
        original_p1 = fan_timeline(text, 1)
        modified_p1 = fan_timeline(modified_text, 1)
        self.assertEqual(original_p1[-1], modified_p1[-1])
        self.assert_no_fan_leak(text, modified_text, [1], fan_index=2)
        self.assertIn("M106 P2 S200", modified_text)

    def test_fan_syntax_matches_the_file(self) -> None:
        bare = self.write("bare.gcode", fixtures.interleaved_with_slicer_fan())
        self.assertEqual(run_cli(["--object", "1=200", bare]).returncode, 0)
        self.assertIn("M106 S200 ;", self.read(bare))

        indexed = self.write("indexed.gcode", fixtures.aux_fan())
        self.assertEqual(run_cli(["--object", "1=200", indexed]).returncode, 0)
        self.assertIn("M106 P1 S200 ;", self.read(indexed))

    def test_zero_becomes_m107_in_bare_syntax(self) -> None:
        path = self.write("a.gcode", fixtures.interleaved_with_slicer_fan())
        self.assertEqual(run_cli(["--object", "1=0", path]).returncode, 0)
        self.assertIn(f"M107 ; {grispr.SENTINEL} force obj=1", self.read(path))

    def test_layers_filter_limits_injection_to_a_region(self) -> None:
        text = fixtures.interleaved_three()
        path = self.write("a.gcode", text)
        result = run_cli(["--object", "1=255", "--layers", "2", path])
        self.assertEqual(result.returncode, 0, result.stderr)
        modified = grispr.split_lines(self.read(path))
        forced = [l for l in modified if "force obj=1" in l]
        self.assertEqual(len(forced), 2)  # object 1 has two blocks on layer 2
        self.assertTrue(all("layer=2" in l for l in forced))
        # Object 1's blocks on layers 1 and 3 must be completely untouched.
        self.assert_no_fan_leak(text, self.read(path), [1], layer_range=(2, 2))

    def test_hold_suppresses_slicer_fan_commands_inside_the_block(self) -> None:
        text = fixtures.interleaved_with_slicer_fan()
        path = self.write("a.gcode", text)
        result = run_cli(["--hold", "--object", "2=0", path])
        self.assertEqual(result.returncode, 0, result.stderr)
        modified_text = self.read(path)
        self.assertIn(f"; {grispr.SENTINEL} suppressed: M106 S255", modified_text)
        # The suppressed overhang command must not still be executable.
        self.assertNotIn("\nM106 S255\n", modified_text)
        # And the fan must still be handed back correctly to object 3.
        doc = grispr.parse_gcode(grispr.split_lines(modified_text))
        timeline = grispr.original_fan_timeline(grispr.split_lines(modified_text), 1)
        obj3_layer2 = [b for b in doc.blocks if b.object_id == 3 and b.layer == 2][0]
        self.assertEqual(timeline[obj3_layer2.start_index], 255)

    def test_hold_does_not_leak_to_other_objects(self) -> None:
        """Even with the object's own fan commands suppressed, neighbours are safe."""
        text = fixtures.interleaved_with_slicer_fan()
        for target in (1, 2, 3):
            with self.subTest(target=target):
                path = self.write(f"hold{target}.gcode", text)
                result = run_cli(["--hold", "--object", f"{target}=255", path])
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assert_no_fan_leak(text, self.read(path), [target])

    def test_restore_to_off_when_file_had_no_prior_fan_command(self) -> None:
        """With no prior command the fan is off, so the restore must turn it off."""
        text = fixtures.two_objects()
        path = self.write("a.gcode", text)
        self.assertEqual(run_cli(["--object", "1=255", path]).returncode, 0)
        modified = grispr.split_lines(self.read(path))
        restores = [l for l in modified if "restore obj=1" in l]
        self.assertEqual(len(restores), 3)
        for line in restores:
            self.assertEqual(grispr.parse_fan_command(line), (1, 0))
            self.assertIn("no prior state", line)
        doc = grispr.parse_gcode(modified)
        timeline = grispr.original_fan_timeline(modified, 1)
        for block in doc.blocks:
            if block.object_id == 2:
                self.assertEqual(timeline[block.start_index], 0)

    def test_hold_is_reversible(self) -> None:
        text = fixtures.interleaved_with_slicer_fan()
        path = self.write("a.gcode", text)
        self.assertEqual(run_cli(["--hold", "--object", "2=0", path]).returncode, 0)
        restored, _ = grispr.strip_previous_run(grispr.split_lines(self.read(path)))
        self.assertEqual("\n".join(restored), text)


# ---------------------------------------------------------------------------
# Task 3 - safe failure
# ---------------------------------------------------------------------------


class TestSafeFailure(GrisprTestCase):
    def test_malformed_files_abort_without_touching_the_input(self) -> None:
        for name, builder in fixtures.MALFORMED.items():
            with self.subTest(fixture=name):
                text = builder()
                path = self.write(f"{name}.gcode", text)
                result = run_cli(["--object", "1=255", path])
                self.assertNotEqual(
                    result.returncode, 0, f"{name} should not succeed"
                )
                self.assertIn("grispr: error:", result.stderr)
                self.assert_unchanged(path, text)
                self.assert_no_temp_files()

    def test_error_messages_name_the_problem(self) -> None:
        cases = {
            "unclosed_start": "never closed",
            "orphan_stop": "no matching start marker",
            "nested_start": "still open",
            "mismatched_stop": "does not match",
            "no_markers": "no object print-block markers found",
            "object_id_markers_only": "distinct object ids",
        }
        for name, needle in cases.items():
            with self.subTest(fixture=name):
                path = self.write(f"{name}.gcode", fixtures.MALFORMED[name]())
                result = run_cli(["--object", "1=255", path])
                self.assertIn(needle, result.stderr)

    def test_unrecognised_file_is_not_a_silent_no_op(self) -> None:
        text = fixtures.no_markers()
        path = self.write("plain.gcode", text)
        result = run_cli(["--object", "1=255", path])
        self.assertEqual(result.returncode, grispr.EXIT_PARSE)
        self.assert_unchanged(path, text)

    def test_missing_target_object_fails_loudly(self) -> None:
        text = fixtures.two_objects()
        path = self.write("a.gcode", text)
        result = run_cli(["--object", "99=255", path])
        self.assertEqual(result.returncode, grispr.EXIT_TARGET_MISSING)
        self.assertIn("99", result.stderr)
        self.assertIn("Objects present: 1,2", result.stderr)
        self.assert_unchanged(path, text)

    def test_allow_missing_opts_into_a_no_op(self) -> None:
        text = fixtures.two_objects()
        path = self.write("a.gcode", text)
        result = run_cli(["--allow-missing", "--object", "99=255", path])
        self.assertEqual(result.returncode, 0)
        self.assert_unchanged(path, text)

    def test_allow_missing_still_applies_the_ids_that_exist(self) -> None:
        text = fixtures.two_objects()
        path = self.write("a.gcode", text)
        result = run_cli(
            ["--allow-missing", "--object", "99=255", "--object", "1=64", path]
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("force obj=1", self.read(path))
        self.assert_no_fan_leak(text, self.read(path), [1])

    def test_no_targets_is_a_usage_error(self) -> None:
        text = fixtures.two_objects()
        path = self.write("a.gcode", text)
        result = run_cli([path])
        self.assertEqual(result.returncode, grispr.EXIT_USAGE)
        self.assert_unchanged(path, text)

    def test_missing_file_argument(self) -> None:
        self.assertEqual(run_cli(["--object", "1=255"]).returncode, grispr.EXIT_USAGE)

    def test_nonexistent_file(self) -> None:
        result = run_cli(["--object", "1=255", os.path.join(self.tmp, "nope.gcode")])
        self.assertEqual(result.returncode, grispr.EXIT_IO)
        self.assertIn("no such file", result.stderr)

    def test_binary_file_is_refused(self) -> None:
        path = os.path.join(self.tmp, "bin.gcode")
        with open(path, "wb") as handle:
            handle.write(b"; HEADER\x00\x01\x02 not text\n")
        with open(path, "rb") as handle:
            before = handle.read()
        result = run_cli(["--object", "1=255", path])
        self.assertEqual(result.returncode, grispr.EXIT_IO)
        with open(path, "rb") as handle:
            self.assertEqual(handle.read(), before)

    def test_bad_object_spec(self) -> None:
        path = self.write("a.gcode", fixtures.two_objects())
        for bad in ("1", "x=255", "1=999"):
            with self.subTest(spec=bad):
                self.assertEqual(
                    run_cli(["--object", bad, path]).returncode, grispr.EXIT_USAGE
                )

    def test_objects_without_fan_is_a_usage_error(self) -> None:
        path = self.write("a.gcode", fixtures.two_objects())
        self.assertEqual(run_cli(["--objects", "1,2", path]).returncode,
                         grispr.EXIT_USAGE)

    def test_layers_on_a_file_without_layer_markers_fails(self) -> None:
        text = fixtures.no_layer_markers()
        path = self.write("a.gcode", text)
        result = run_cli(["--object", "1=255", "--layers", "2", path])
        self.assertNotEqual(result.returncode, 0)
        self.assert_unchanged(path, text)

    def test_bad_layer_range(self) -> None:
        path = self.write("a.gcode", fixtures.two_objects())
        for bad in ("x", "5-2", "1-"):
            with self.subTest(value=bad):
                self.assertEqual(
                    run_cli(["--object", "1=255", "--layers", bad, path]).returncode,
                    grispr.EXIT_USAGE,
                )

    def test_rerun_without_force_is_refused(self) -> None:
        path = self.write("a.gcode", fixtures.two_objects())
        self.assertEqual(run_cli(["--object", "1=255", path]).returncode, 0)
        once = self.read(path)
        result = run_cli(["--object", "1=255", path])
        self.assertEqual(result.returncode, grispr.EXIT_USAGE)
        self.assertIn("already contains", result.stderr)
        self.assert_unchanged(path, once)

    def test_force_rerun_is_idempotent(self) -> None:
        path = self.write("a.gcode", fixtures.interleaved_with_slicer_fan())
        self.assertEqual(run_cli(["--object", "1=255", path]).returncode, 0)
        once = self.read(path)
        self.assertEqual(run_cli(["--force", "--object", "1=255", path]).returncode, 0)
        self.assertEqual(self.read(path), once)

    def test_force_rerun_with_different_value_replaces_not_stacks(self) -> None:
        text = fixtures.interleaved_with_slicer_fan()
        path = self.write("a.gcode", text)
        self.assertEqual(run_cli(["--object", "1=255", path]).returncode, 0)
        self.assertEqual(run_cli(["--force", "--object", "1=64", path]).returncode, 0)
        modified = self.read(path)
        self.assertNotIn("M106 S255 ;", modified)
        self.assertIn("M106 S64 ;", modified)
        self.assert_no_fan_leak(text, modified, [1])

    def test_dry_run_never_writes(self) -> None:
        text = fixtures.two_objects()
        path = self.write("a.gcode", text)
        result = run_cli(["--dry-run", "--object", "1=255", path])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("left unchanged", result.stdout)
        self.assert_unchanged(path, text)

    def test_list_never_writes(self) -> None:
        text = fixtures.interleaved_three()
        path = self.write("a.gcode", text)
        result = run_cli(["--list", path])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("print block(s)", result.stdout)
        self.assert_unchanged(path, text)

    def test_list_reports_interleave(self) -> None:
        path = self.write("a.gcode", fixtures.interleaved_three())
        result = run_cli(["--list", path])
        self.assertIn("layer 2: objects 1,2,3", result.stdout)
        self.assertIn("true interleave", result.stdout)

    def test_list_on_malformed_file_still_fails(self) -> None:
        path = self.write("a.gcode", fixtures.nested_start())
        self.assertNotEqual(run_cli(["--list", path]).returncode, 0)

    def test_backup_preserves_the_original(self) -> None:
        text = fixtures.two_objects()
        path = self.write("a.gcode", text)
        self.assertEqual(run_cli(["--backup", "--object", "1=255", path]).returncode, 0)
        self.assertEqual(self.read(path + ".grispr.bak"), text)
        self.assertNotEqual(self.read(path), text)

    def test_no_temp_files_left_on_success(self) -> None:
        path = self.write("a.gcode", fixtures.two_objects())
        self.assertEqual(run_cli(["--object", "1=255", path]).returncode, 0)
        self.assert_no_temp_files()


# ---------------------------------------------------------------------------
# Task 4 - Bambu Studio post-processing integration
# ---------------------------------------------------------------------------


class TestIntegration(GrisprTestCase):
    def test_file_path_as_last_argument_in_place(self) -> None:
        """Bambu Studio appends the sliced file path after the user's own args."""
        text = fixtures.interleaved_three()
        path = self.write("plate_1.gcode", text)
        inode_before = os.stat(path).st_ino
        result = subprocess.run(
            [sys.executable, SCRIPT, "--object", "2=255", "--object", "3=0", path],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(os.path.isfile(path))
        self.assertNotEqual(self.read(path), text)
        self.assert_no_fan_leak(text, self.read(path), [2, 3])
        # in-place means the same path, and nothing new alongside it
        self.assertEqual(os.listdir(self.tmp), ["plate_1.gcode"])
        self.assertIsInstance(inode_before, int)

    def test_only_positional_argument_is_the_path(self) -> None:
        path = self.write("a.gcode", fixtures.two_objects())
        result = run_cli(["--objects", "1,2", "--fan", "60%", path])
        self.assertEqual(result.returncode, 0, result.stderr)
        # This fixture contains no M106 at all, so auto-detect falls back to the
        # explicit indexed form. 60% of 255 = 153.
        self.assertIn("M106 P1 S153", self.read(path))

    def test_path_with_spaces(self) -> None:
        text = fixtures.two_objects()
        path = self.write("My Plate 1.gcode", text)
        result = run_cli(["--object", "1=255", path])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_no_fan_leak(text, self.read(path), [1])

    def test_crlf_line_endings_round_trip(self) -> None:
        text = fixtures.crlf_two_objects()
        path = self.write("crlf.gcode", text)
        result = run_cli(["--object", "1=255", path])
        self.assertEqual(result.returncode, 0, result.stderr)
        modified = self.read(path)
        self.assertIn("\r\n", modified)
        # Stripping every CRLF must leave no stray CR or LF anywhere: that is
        # only true if all separators, inserted lines included, are CRLF.
        self.assertNotIn("\n", modified.replace("\r\n", ""))
        self.assertNotIn("\r", modified.replace("\r\n", ""))
        self.assertIn("@grispr force obj=1", modified)
        self.assert_no_fan_leak(text, modified, [1])

    def test_trailing_newline_preserved(self) -> None:
        path = self.write("a.gcode", fixtures.two_objects())
        self.assertEqual(run_cli(["--object", "1=255", path]).returncode, 0)
        self.assertTrue(self.read(path).endswith("\n"))

    def test_file_without_trailing_newline(self) -> None:
        text = fixtures.two_objects().rstrip("\n")
        path = self.write("a.gcode", text)
        result = run_cli(["--object", "1=255", path])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_no_fan_leak(text, self.read(path), [1])

    def test_non_utf8_bytes_round_trip(self) -> None:
        """A thumbnail or comment with odd bytes must come back byte-identical."""
        path = os.path.join(self.tmp, "bytes.gcode")
        payload = b"; thumbnail junk \xff\xfe\x80 end\n"
        with open(path, "wb") as handle:
            handle.write(payload + fixtures.two_objects().encode())
        result = run_cli(["--object", "1=255", path])
        self.assertEqual(result.returncode, 0, result.stderr)
        with open(path, "rb") as handle:
            self.assertTrue(handle.read().startswith(payload))

    def test_output_reparses_cleanly(self) -> None:
        """The modified file must still be valid input for the parser."""
        for name, builder in fixtures.WELL_FORMED.items():
            with self.subTest(fixture=name):
                text = builder()
                doc = grispr.parse_gcode(grispr.split_lines(text))
                target = sorted({b.object_id for b in doc.blocks})[0]
                path = self.write(f"{name}.gcode", text)
                self.assertEqual(
                    run_cli(["--object", f"{target}=180", path]).returncode, 0
                )
                after = grispr.parse_gcode(grispr.split_lines(self.read(path)))
                self.assertEqual(len(after.blocks), len(doc.blocks))
                self.assertEqual(
                    [b.object_id for b in after.blocks],
                    [b.object_id for b in doc.blocks],
                )

    def test_stdout_is_quiet_under_quiet(self) -> None:
        path = self.write("a.gcode", fixtures.two_objects())
        result = run_cli(["--quiet", "--object", "1=255", path])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_sentinel_records_provenance(self) -> None:
        path = self.write("a.gcode", fixtures.two_objects())
        self.assertEqual(run_cli(["--object", "1=255", path]).returncode, 0)
        self.assertIn(f"; {grispr.SENTINEL} processed by grispr", self.read(path))


class TestInferredBlocks(GrisprTestCase):
    """The '; OBJECT_ID:' only shape, as emitted by the real single-object slice.

    Bambu Studio does not always write the labelled start/stop pair. The
    reference file carries 105 '; OBJECT_ID: 518' markers and no start or stop
    marker at all, so block ends are inferred.
    """

    def test_parses_one_block_per_layer(self) -> None:
        doc = grispr.parse_gcode(grispr.split_lines(fixtures.object_id_single()))
        self.assertEqual(doc.marker_mode, "object_id")
        self.assertEqual(len(doc.blocks), 3)
        self.assertEqual({b.object_id for b in doc.blocks}, {518})
        self.assertEqual([b.layer for b in doc.blocks], [1, 2, 3])

    def test_block_starts_on_the_object_id_line(self) -> None:
        lines = grispr.split_lines(fixtures.object_id_single())
        doc = grispr.parse_gcode(lines)
        for block in doc.blocks:
            self.assertRegex(lines[block.start_index], r"OBJECT_ID: 518")

    def test_block_spans_the_timelapse_block_and_the_infill_after_it(self) -> None:
        """The object's toolpath resumes after the timelapse, so it is included."""
        lines = grispr.split_lines(fixtures.object_id_single())
        doc = grispr.parse_gcode(lines)
        body = lines[doc.blocks[0].start_index : doc.blocks[0].stop_index + 1]
        self.assertIn("; SKIPPABLE_START", body)
        self.assertIn("; SKIPPABLE_END", body)
        self.assertIn("; FEATURE: Sparse infill", body)
        self.assertIn("; WIPE_END", body)

    def test_block_stops_before_the_next_layer(self) -> None:
        lines = grispr.split_lines(fixtures.object_id_single())
        doc = grispr.parse_gcode(lines)
        for block in doc.blocks[:-1]:
            after = lines[block.stop_index + 1 :]
            next_real = next(l for l in after if grispr.strip_eol(l).strip())
            self.assertRegex(next_real, r"CHANGE_LAYER")

    def test_last_block_stops_at_the_final_extruding_move(self) -> None:
        """End-of-print fan shutdown must fall OUTSIDE the last block.

        Otherwise --hold comments it out and the fan runs on after the print.
        """
        lines = grispr.split_lines(fixtures.object_id_single())
        doc = grispr.parse_gcode(lines)
        last = doc.blocks[-1]
        self.assertEqual(last.stop_index, grispr.last_extruding_move(lines))
        tail = lines[last.stop_index + 1 :]
        self.assertTrue(
            any("turn off fan" in l for l in tail),
            "the end-gcode fan shutdown was swallowed by the last block",
        )

    def test_hold_does_not_suppress_the_end_gcode_fan_shutdown(self) -> None:
        text = fixtures.object_id_single()
        path = self.write("real.gcode", text)
        result = run_cli(["--hold", "--object", "518=255", path])
        self.assertEqual(result.returncode, 0, result.stderr)
        modified = self.read(path)
        for command in (
            "M106 S0 ; turn off fan",
            "M106 P2 S0 ; turn off remote part cooling fan",
            "M106 P3 S0 ; turn off chamber cooling fan",
        ):
            self.assertIn(
                "\n" + command,
                modified,
                f"{command!r} was suppressed - the fan would run on after the print",
            )

    def test_no_leak_in_inferred_mode(self) -> None:
        text = fixtures.object_id_single()
        for hold in (False, True):
            with self.subTest(hold=hold):
                path = self.write(f"h{int(hold)}.gcode", text)
                args = (["--hold"] if hold else []) + ["--object", "518=255", path]
                self.assertEqual(run_cli(args).returncode, 0)
                self.assert_no_fan_leak(text, self.read(path), [518])

    def test_fractional_fan_speed_is_restored_exactly(self) -> None:
        """Bambu writes M106 S196.35; rounding it on restore would shift the fan."""
        text = fixtures.object_id_single()
        path = self.write("frac.gcode", text)
        self.assertEqual(run_cli(["--object", "518=255", path]).returncode, 0)
        modified = self.read(path)
        self.assertIn("M106 S196.35 ; @grispr restore", modified)
        self.assertIn("M106 S201.45 ; @grispr restore", modified)
        self.assertNotIn("S196.0", modified)

    def test_m107_not_introduced_into_a_file_that_never_uses_it(self) -> None:
        text = fixtures.object_id_single()
        self.assertNotIn("M107", text)
        path = self.write("nom107.gcode", text)
        self.assertEqual(run_cli(["--object", "518=0", path]).returncode, 0)
        modified = self.read(path)
        self.assertNotIn("M107", modified)
        self.assertIn("M106 S0 ; @grispr force obj=518", modified)

    def test_m107_still_used_where_the_file_uses_it(self) -> None:
        text = fixtures.interleaved_with_slicer_fan()
        self.assertIn("M107", text)
        path = self.write("m107.gcode", text)
        self.assertEqual(run_cli(["--object", "1=0", path]).returncode, 0)
        self.assertIn("M107 ; @grispr force obj=1", self.read(path))

    def test_multi_object_inferred_write_is_refused(self) -> None:
        text = fixtures.object_id_markers_only()
        path = self.write("multi.gcode", text)
        result = run_cli(["--object", "1=255", path])
        self.assertEqual(result.returncode, grispr.EXIT_PARSE)
        self.assertIn("distinct object ids", result.stderr)
        self.assertIn("labelling enabled", result.stderr)
        self.assert_unchanged(path, text)

    def test_multi_object_inferred_list_still_works(self) -> None:
        path = self.write("multi.gcode", fixtures.object_id_markers_only())
        result = run_cli(["--list", path])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("OBJECT_ID only", result.stdout)
        self.assertIn("NOT verified", result.stderr)

    def test_list_labels_the_marker_mode(self) -> None:
        inferred = self.write("a.gcode", fixtures.object_id_single())
        self.assertIn("OBJECT_ID only", run_cli(["--list", inferred]).stdout)
        labelled = self.write("b.gcode", fixtures.two_objects())
        self.assertIn("start/stop labels", run_cli(["--list", labelled]).stdout)


class TestRandomised(GrisprTestCase):
    """Property check: the no-leak invariant should hold for arbitrary layouts.

    Hand-written fixtures encode the cases we thought of. This generates messy
    ones - random interleave orders, random re-entries, random ambient fan
    changes between and inside blocks - and asserts the same invariant.
    """

    def test_invariant_holds_on_random_layouts(self) -> None:
        import random

        rng = random.Random(20260914)
        for trial in range(60):
            object_ids = list(range(1, rng.randint(2, 5)))
            layers = []
            for layer_number in range(1, rng.randint(2, 5)):
                sequence = []
                for _ in range(rng.randint(1, 7)):
                    object_id = rng.choice(object_ids)
                    body = [f"G1 X{rng.randint(1, 99)} Y{rng.randint(1, 99)} E0.3"]
                    if rng.random() < 0.35:
                        # the slicer's own fan change inside the block
                        body.insert(
                            rng.randint(0, len(body)),
                            f"M106 S{rng.choice([0, 64, 128, 255])}",
                        )
                    sequence.append((object_id, body))
                block = fixtures.layer(layer_number, sequence)
                if rng.random() < 0.5:
                    # ambient fan change at the layer boundary
                    block.insert(4, f"M106 S{rng.choice([0, 51, 102, 153, 204])}")
                layers.append(block)

            text = fixtures.assemble(layers)
            # Sample targets from the ids that actually got a block: a random
            # layout need not contain every id in object_ids.
            present = sorted(
                {b.object_id for b in grispr.parse_gcode(grispr.split_lines(text)).blocks}
            )
            targets = rng.sample(present, rng.randint(1, len(present)))
            hold = rng.random() < 0.3

            with self.subTest(trial=trial, targets=targets, hold=hold):
                path = self.write(f"rand{trial}.gcode", text)
                args = ["--hold"] if hold else []
                for object_id in targets:
                    args += ["--object", f"{object_id}={rng.choice([0, 128, 255])}"]
                result = run_cli(args + [path])
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assert_no_fan_leak(text, self.read(path), targets)


if __name__ == "__main__":
    unittest.main(verbosity=2)
