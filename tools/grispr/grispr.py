#!/usr/bin/env python3
"""
Grispr - per-object fan control for sliced Bambu Studio G-code.

Bambu Studio has no per-object fan control in its UI or its 3MF schema. Grispr
works around that by post-processing the *sliced G-code*, downstream of both the
slicer and the filament-preset system, so it never depends on filament-profile
state and can target individual objects the 3MF schema cannot express.

It relies on the object markers Bambu Studio already emits:

    ; OBJECT_ID: 3
    ; start printing object, unique label id: 3
    ...toolpath...
    ; stop printing object, unique label id: 3

plus the per-layer manifests:

    ; object ids of layer 5 start: 3,7
    ; object ids of layer 5 end: 3,7

The `unique label id` matches the `identify_id` field in the exported 3MF's
Metadata/model_settings.config, which is what lets an upstream tool address a
specific object it generated.

Design rules (see README.md for the full rationale):

  * Boundary injection only, by default. Grispr injects a forced fan speed at an
    object's start marker and restores the fan at its stop marker. It does NOT
    remove the slicer's own M106/M107 commands inside the object, because those
    include Bambu's native overhang/bridge fan forcing
    (enable_overhang_bridge_fan). Use --hold to override that, with the
    understanding that it defeats overhang fan forcing for that object.
  * Restore is computed, never hardcoded. The value written at a stop marker is
    the fan state the *unmodified* file would have had at that point, so state
    cannot leak between objects that interleave on one layer.
  * Fail loud, never silent. Unpaired, nested, or missing markers abort with a
    non-zero exit and the input file is left byte-for-byte untouched. The write
    is atomic (temp file + os.replace), so an interrupted run cannot truncate
    your G-code.

Usage as a Bambu Studio post-processing script (Others tab):

    /path/to/grispr.py --object 3=255 --object 7=0

Bambu Studio appends the sliced file's absolute path as the LAST argument, so
the file path is taken as the single positional argument. Run it directly the
same way: grispr.py --object 3=255 model.gcode
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

VERSION = "0.1.0"

# Sentinel written into every line Grispr inserts. Used both to mark provenance
# and to find/strip a previous run's insertions (--force).
SENTINEL = "@grispr"

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_PARSE = 3
EXIT_TARGET_MISSING = 4
EXIT_IO = 5

# --- marker patterns ---------------------------------------------------------
# Anchored on the comment form Bambu Studio emits. Kept deliberately strict:
# a file that does not match these is reported as unrecognised rather than
# silently producing zero edits.

RE_START = re.compile(
    r"^\s*;\s*start\s+printing\s+object,\s*unique\s+label\s+id:\s*(\d+)\s*$",
    re.IGNORECASE,
)
RE_STOP = re.compile(
    r"^\s*;\s*stop\s+printing\s+object,\s*unique\s+label\s+id:\s*(\d+)\s*$",
    re.IGNORECASE,
)
RE_OBJECT_ID = re.compile(r"^\s*;\s*OBJECT_ID:\s*(\d+)\s*$", re.IGNORECASE)
RE_LAYER_MANIFEST = re.compile(
    r"^\s*;\s*object\s+ids\s+of\s+layer\s+(\d+)\s+(start|end)\s*:\s*(.*?)\s*$",
    re.IGNORECASE,
)
RE_LAYER_NUM = re.compile(
    r"^\s*;\s*layer\s+num/total_layer_count:\s*(\d+)\s*/", re.IGNORECASE
)
RE_CHANGE_LAYER = re.compile(r"^\s*;\s*(?:CHANGE_LAYER|LAYER_CHANGE)\s*$", re.IGNORECASE)
RE_EXEC_BLOCK_END = re.compile(r"^\s*;\s*EXECUTABLE_BLOCK_END\s*$", re.IGNORECASE)
# A move that lays down material: G0-G3 with a POSITIVE E. Retractions and wipe
# moves carry a negative E and do not count.
RE_EXTRUDING_MOVE = re.compile(r"^\s*G[0-3]\b.*\bE\d*\.?\d+", re.IGNORECASE)

# --- fan command patterns ----------------------------------------------------

RE_M106 = re.compile(r"^\s*M106(?:\s|$)", re.IGNORECASE)
RE_M107 = re.compile(r"^\s*M107(?:\s|$)", re.IGNORECASE)
RE_PARAM_P = re.compile(r"\bP(\d+)\b", re.IGNORECASE)
RE_PARAM_S = re.compile(r"\bS(\d+(?:\.\d+)?)\b", re.IGNORECASE)

DEFAULT_FAN_INDEX = 1  # Bambu: P1 part cooling, P2 aux, P3 chamber


class GrisprError(Exception):
    """Fatal condition. The input file is never modified when this is raised."""

    def __init__(self, message: str, code: int = EXIT_PARSE) -> None:
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------
# G-code text handling
# ---------------------------------------------------------------------------


def split_lines(text: str) -> List[str]:
    """Split on '\\n' only.

    str.splitlines() also breaks on \\x0b, \\x0c, \\x1c-\\x1e, \\x85, \\u2028 and
    \\u2029. Those bytes can legitimately appear inside a Bambu thumbnail or an
    embedded comment, and splitting on them would silently reflow the file. Any
    trailing '\\r' stays attached to the line content so CRLF files round-trip
    byte-for-byte.
    """
    return text.split("\n")


def strip_eol(line: str) -> str:
    return line[:-1] if line.endswith("\r") else line


def code_part(line: str) -> str:
    """The line with its trailing comment removed."""
    return strip_eol(line).split(";", 1)[0]


def detect_newline(lines: Sequence[str]) -> str:
    """Return the newline sequence to use for inserted lines."""
    for line in lines:
        if line.endswith("\r"):
            return "\r\n"
        if line.strip():
            return "\n"
    return "\n"


# ---------------------------------------------------------------------------
# Fan state model
# ---------------------------------------------------------------------------


def format_speed(speed: float) -> str:
    """Render a fan speed, keeping a fractional value the slicer wrote.

    Bambu emits non-integer speeds (M106 S196.35 appears 1222 times in the
    reference file), so rounding to int on restore would silently shift the
    fan. Integral values still print without a decimal point.
    """
    if float(speed).is_integer():
        return str(int(speed))
    return f"{speed:g}"


def parse_fan_command(line: str) -> Optional[Tuple[int, float]]:
    """Parse a fan command into (fan_index, speed 0-255), or None.

    Handles the forms Bambu Studio and Marlin emit:
        M106 S255        -> (1, 255)   bare M106 targets the part cooling fan
        M106 P2 S128     -> (2, 128)
        M106             -> (1, 255)   Marlin: no S means full speed
        M107             -> (1, 0)
        M107 P2          -> (2, 0)
    Only the code portion is inspected, so 'M106' inside a comment is ignored.
    """
    code = code_part(line)
    if not code.strip():
        return None

    if RE_M107.match(code):
        m_p = RE_PARAM_P.search(code)
        index = int(m_p.group(1)) if m_p else DEFAULT_FAN_INDEX
        return (index, 0.0)

    if RE_M106.match(code):
        m_p = RE_PARAM_P.search(code)
        index = int(m_p.group(1)) if m_p else DEFAULT_FAN_INDEX
        m_s = RE_PARAM_S.search(code)
        speed = 255.0 if m_s is None else float(m_s.group(1))
        return (index, max(0.0, min(255.0, speed)))

    return None


def format_fan_command(
    index: int, speed: float, syntax: str, use_m107: bool = False
) -> str:
    """Render a fan command in the file's own syntax.

    `use_m107` is set only when the file itself uses M107. The reference Bambu
    file writes "M106 S0" 6 times and M107 not once, so emitting M107 there
    would introduce a form the rest of the file never uses.
    """
    if speed == 0 and use_m107 and syntax != "indexed" and index == DEFAULT_FAN_INDEX:
        return "M107"
    if syntax == "bare" and index == DEFAULT_FAN_INDEX:
        return f"M106 S{format_speed(speed)}"
    return f"M106 P{index} S{format_speed(speed)}"


def detect_fan_syntax(lines: Iterable[str], fan_index: int) -> str:
    """'bare' if the file writes the managed fan as 'M106 S..', else 'indexed'."""
    bare = indexed = 0
    for line in lines:
        code = code_part(line)
        if not RE_M106.match(code):
            continue
        m_p = RE_PARAM_P.search(code)
        if m_p is None:
            if fan_index == DEFAULT_FAN_INDEX:
                bare += 1
        elif int(m_p.group(1)) == fan_index:
            indexed += 1
    if bare == 0 and indexed == 0:
        return "indexed"
    return "bare" if bare >= indexed else "indexed"


def file_uses_m107(lines: Iterable[str]) -> bool:
    return any(RE_M107.match(code_part(line)) for line in lines)


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


@dataclass
class Block:
    """One contiguous print block for a single object."""

    object_id: int
    start_index: int  # 0-based index of the start marker line
    stop_index: int  # 0-based index of the stop marker line
    layer: Optional[int]
    ordinal: int  # 0-based position among all blocks in the file

    @property
    def start_line(self) -> int:
        return self.start_index + 1

    @property
    def stop_line(self) -> int:
        return self.stop_index + 1


@dataclass
class Document:
    lines: List[str]
    marker_mode: str = "label"  # 'label' (start/stop pairs) | 'object_id'
    blocks: List[Block] = field(default_factory=list)
    layer_manifest: Dict[int, List[int]] = field(default_factory=dict)
    object_id_markers: int = 0
    warnings: List[str] = field(default_factory=list)
    newline: str = "\n"
    previous_run_lines: List[int] = field(default_factory=list)


def _parse_id_list(raw: str) -> List[int]:
    out: List[int] = []
    for chunk in re.split(r"[,\s]+", raw.strip()):
        if chunk.isdigit():
            out.append(int(chunk))
    return out


def last_extruding_move(lines: Sequence[str]) -> Optional[int]:
    """Index of the final move that extrudes material.

    Everything after it is end-of-print machinery by definition, whatever
    comments the slicer does or does not wrap it in.
    """
    for index in range(len(lines) - 1, -1, -1):
        if RE_EXTRUDING_MOVE.match(code_part(lines[index])):
            return index
    return None


def parse_object_id_only(lines: List[str]) -> Document:
    """Parse a file that carries '; OBJECT_ID: <id>' but no start/stop pairs.

    Bambu Studio does not always emit the labelled start/stop pair. The
    reference single-object file carries 105 '; OBJECT_ID: 518' markers - one
    per layer - and not a single start or stop marker, so the end of each
    object block has to be inferred rather than read.

    The rule, checked against that file: a block runs from its '; OBJECT_ID:'
    line to the line before whichever comes first of the next '; OBJECT_ID:',
    the next '; CHANGE_LAYER', or '; EXECUTABLE_BLOCK_END'. Note that the
    object's toolpath continues *after* the embedded timelapse block
    (';  SKIPPABLE_START' ... ';  SKIPPABLE_END'), which is why the terminator
    is the layer change and not the timelapse marker.

    This inference is only verified for the single-object shape. Callers must
    treat a multi-object file in this mode as unverified - see run().
    """
    doc = Document(lines=lines, marker_mode="object_id", newline=detect_newline(lines))

    starts: List[Tuple[int, int]] = []  # (line index, object id)
    terminators: List[int] = []
    current_layer: Optional[int] = None
    layer_at: Dict[int, Optional[int]] = {}

    for index, raw in enumerate(lines):
        line = strip_eol(raw)

        if SENTINEL in line:
            doc.previous_run_lines.append(index)

        m_layer_num = RE_LAYER_NUM.match(line)
        if m_layer_num:
            current_layer = int(m_layer_num.group(1))
            continue

        m_object = RE_OBJECT_ID.match(line)
        if m_object:
            doc.object_id_markers += 1
            starts.append((index, int(m_object.group(1))))
            layer_at[index] = current_layer
            terminators.append(index)
            continue

        if RE_CHANGE_LAYER.match(line) or RE_EXEC_BLOCK_END.match(line):
            terminators.append(index)

    terminators.sort()

    # An inferred block must never run past the file's final extruding move.
    # Without this, the last block swallows the end-of-print gcode: in the
    # reference file that means the four fan-shutdown commands, and --hold
    # would comment them out and leave the fan running after the print.
    print_end = last_extruding_move(lines)

    for position, (start_index, object_id) in enumerate(starts):
        # first terminator strictly after this start
        end_index = len(lines) - 1
        for candidate in terminators:
            if candidate > start_index:
                end_index = candidate - 1
                break
        if print_end is not None and start_index <= print_end:
            end_index = min(end_index, print_end)
        # back up over trailing blank lines so the restore lands right after
        # the object's last real command
        while end_index > start_index and not strip_eol(lines[end_index]).strip():
            end_index -= 1
        doc.blocks.append(
            Block(
                object_id=object_id,
                start_index=start_index,
                stop_index=end_index,
                layer=layer_at.get(start_index),
                ordinal=position,
            )
        )

    doc.warnings.append(
        "this file has no 'start/stop printing object' markers; block ends were "
        "inferred from '; OBJECT_ID:' / '; CHANGE_LAYER' boundaries"
    )
    if len({object_id for _, object_id in starts}) > 1:
        doc.warnings.append(
            "more than one object id in a file without start/stop markers: the "
            "inferred block ends are NOT verified for this shape"
        )
    return doc


def parse_gcode(lines: List[str]) -> Document:
    """Locate every object print block. Raises GrisprError on malformed markers.

    Multiple objects interleaving inside a single layer is the normal case and is
    handled by treating blocks as a flat, ordered sequence rather than assuming
    one object per layer. Nested start markers are treated as fatal, because
    Bambu never emits them and a nested marker means the pattern assumption no
    longer holds.
    """
    doc = Document(lines=lines, newline=detect_newline(lines))

    open_id: Optional[int] = None
    open_index: Optional[int] = None
    open_layer: Optional[int] = None
    current_layer: Optional[int] = None
    saw_layer_signal = False

    for index, raw in enumerate(lines):
        line = strip_eol(raw)

        if SENTINEL in line:
            doc.previous_run_lines.append(index)

        m_manifest = RE_LAYER_MANIFEST.match(line)
        if m_manifest:
            layer = int(m_manifest.group(1))
            kind = m_manifest.group(2).lower()
            saw_layer_signal = True
            if kind == "start":
                current_layer = layer
                doc.layer_manifest[layer] = _parse_id_list(m_manifest.group(3))
            continue

        m_layer_num = RE_LAYER_NUM.match(line)
        if m_layer_num:
            current_layer = int(m_layer_num.group(1))
            saw_layer_signal = True
            continue

        if RE_CHANGE_LAYER.match(line):
            saw_layer_signal = True
            continue

        if RE_OBJECT_ID.match(line):
            doc.object_id_markers += 1
            continue

        m_start = RE_START.match(line)
        if m_start:
            object_id = int(m_start.group(1))
            if open_id is not None:
                raise GrisprError(
                    f"line {index + 1}: start marker for object {object_id} while "
                    f"object {open_id} is still open (started at line "
                    f"{open_index + 1}). Nested object blocks are not part of the "
                    f"expected Bambu marker pattern; refusing to modify the file."
                )
            open_id = object_id
            open_index = index
            open_layer = current_layer
            continue

        m_stop = RE_STOP.match(line)
        if m_stop:
            object_id = int(m_stop.group(1))
            if open_id is None:
                raise GrisprError(
                    f"line {index + 1}: stop marker for object {object_id} with no "
                    f"matching start marker. Refusing to modify the file."
                )
            if object_id != open_id:
                raise GrisprError(
                    f"line {index + 1}: stop marker for object {object_id} does not "
                    f"match the open start marker for object {open_id} at line "
                    f"{open_index + 1}. Refusing to modify the file."
                )
            doc.blocks.append(
                Block(
                    object_id=open_id,
                    start_index=open_index,
                    stop_index=index,
                    layer=open_layer,
                    ordinal=len(doc.blocks),
                )
            )
            open_id = open_index = open_layer = None
            continue

    if open_id is not None:
        raise GrisprError(
            f"object {open_id} opened at line {open_index + 1} is never closed by a "
            f"stop marker. Refusing to modify a file with unbalanced markers."
        )

    if not doc.blocks:
        if doc.object_id_markers:
            return parse_object_id_only(lines)
        raise GrisprError(
            "no object print-block markers found. Grispr expects Bambu Studio "
            "G-code containing '; start printing object, unique label id: <id>' and "
            "'; stop printing object, unique label id: <id>'. Refusing to modify a "
            "file it does not recognise (exiting non-zero rather than no-op)."
        )

    # Cross-check the per-layer manifests against the blocks actually found.
    # A mismatch does not stop the run, but it is surfaced rather than hidden.
    if doc.layer_manifest:
        observed: Dict[int, set] = {}
        for block in doc.blocks:
            if block.layer is not None:
                observed.setdefault(block.layer, set()).add(block.object_id)
        for layer, declared in sorted(doc.layer_manifest.items()):
            seen = observed.get(layer, set())
            missing = sorted(set(declared) - seen)
            extra = sorted(seen - set(declared))
            if missing:
                doc.warnings.append(
                    f"layer {layer}: manifest declares object(s) "
                    f"{','.join(map(str, missing))} but no print block was found "
                    f"for them on that layer"
                )
            if extra:
                doc.warnings.append(
                    f"layer {layer}: print block(s) found for object(s) "
                    f"{','.join(map(str, extra))} not listed in the layer manifest"
                )

    if not saw_layer_signal:
        doc.warnings.append(
            "no layer markers found; per-layer reporting and --layers are unavailable"
        )

    return doc


# ---------------------------------------------------------------------------
# Fan state timeline
# ---------------------------------------------------------------------------


def original_fan_timeline(
    lines: Sequence[str], fan_index: int
) -> List[Optional[float]]:
    """state_after[i] = managed fan speed after executing lines[0..i].

    None means the file has not yet issued any command for this fan, i.e. the
    printer's power-on default (off) is still in effect.
    """
    state_after: List[Optional[float]] = [None] * len(lines)
    state: Optional[float] = None
    for index, line in enumerate(lines):
        parsed = parse_fan_command(line)
        if parsed is not None and parsed[0] == fan_index:
            state = parsed[1]
        state_after[index] = state
    return state_after


def state_before(
    state_after: Sequence[Optional[float]], index: int
) -> Optional[float]:
    return state_after[index - 1] if index > 0 else None


# ---------------------------------------------------------------------------
# Planning
# ---------------------------------------------------------------------------


@dataclass
class Insertion:
    """A line to insert after `index` (0-based line index)."""

    index: int
    text: str
    kind: str  # 'force' | 'restore'
    block: Optional[Block] = None


@dataclass
class Suppression:
    """An existing fan command to comment out (--hold)."""

    index: int
    original: str
    block: Block


@dataclass
class Plan:
    insertions: List[Insertion] = field(default_factory=list)
    suppressions: List[Suppression] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)
    touched_blocks: List[Block] = field(default_factory=list)


def build_plan(
    doc: Document,
    targets: Dict[int, float],
    fan_index: int,
    syntax: str,
    hold: bool,
    layer_range: Optional[Tuple[int, int]],
    use_m107: bool = False,
) -> Plan:
    """Decide every edit. Pure function - performs no I/O and mutates nothing."""
    plan = Plan()
    state_after = original_fan_timeline(doc.lines, fan_index)

    selected = [b for b in doc.blocks if b.object_id in targets]
    if layer_range is not None:
        low, high = layer_range
        before = len(selected)
        selected = [
            b for b in selected if b.layer is not None and low <= b.layer <= high
        ]
        skipped = before - len(selected)
        if skipped:
            plan.notes.append(
                f"--layers {low}-{high}: skipped {skipped} block(s) outside the range"
            )

    for block in selected:
        forced = targets[block.object_id]
        prior = state_before(state_after, block.start_index)
        prior_text = "unset" if prior is None else "S" + format_speed(prior)

        plan.insertions.append(
            Insertion(
                index=block.start_index,
                text=(
                    f"{format_fan_command(fan_index, forced, syntax, use_m107)} "
                    f"; {SENTINEL} force obj={block.object_id} "
                    f"prev={prior_text} layer={block.layer}"
                ),
                kind="force",
                block=block,
            )
        )

        # Walk the block body to find where the fan actually ends up, both in the
        # modified file and in the original. Restoring to the *original* state at
        # the stop marker is what prevents leakage into whatever prints next.
        actual: Optional[float] = forced
        body = range(block.start_index + 1, block.stop_index + 1)
        for index in body:
            parsed = parse_fan_command(doc.lines[index])
            if parsed is None or parsed[0] != fan_index:
                continue
            if hold:
                plan.suppressions.append(
                    Suppression(
                        index=index, original=doc.lines[index], block=block
                    )
                )
                # suppressed: the forced value stays in effect
            else:
                actual = parsed[1]

        original_at_stop = state_after[block.stop_index]

        if actual != original_at_stop:
            restore_value = 0.0 if original_at_stop is None else original_at_stop
            suffix = (
                " (fan had no prior state in this file; restoring to off)"
                if original_at_stop is None
                else ""
            )
            plan.insertions.append(
                Insertion(
                    index=block.stop_index,
                    text=(
                        f"{format_fan_command(fan_index, restore_value, syntax, use_m107)} "
                        f"; {SENTINEL} restore obj={block.object_id} "
                        f"to={'off' if original_at_stop is None else 'S' + format_speed(original_at_stop)}"
                        f"{suffix}"
                    ),
                    kind="restore",
                    block=block,
                )
            )
        else:
            plan.notes.append(
                f"obj {block.object_id} block at line {block.start_line}: no restore "
                f"needed, fan already matches the original state "
                f"({'off' if original_at_stop is None else 'S' + format_speed(original_at_stop)}) "
                f"at the stop marker"
            )

        plan.touched_blocks.append(block)

    return plan


def apply_plan(doc: Document, plan: Plan) -> List[str]:
    """Produce the new line list. Insertions go *after* their anchor line."""
    by_index: Dict[int, List[Insertion]] = {}
    for insertion in plan.insertions:
        by_index.setdefault(insertion.index, []).append(insertion)

    suppressed = {s.index for s in plan.suppressions}

    out: List[str] = []
    for index, line in enumerate(doc.lines):
        if index in suppressed:
            body = strip_eol(line)
            eol = "\r" if line.endswith("\r") else ""
            out.append(f"; {SENTINEL} suppressed: {body}{eol}")
        else:
            out.append(line)
        for insertion in by_index.get(index, []):
            out.append(insertion.text + ("\r" if doc.newline == "\r\n" else ""))
    return out


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def format_block_map(doc: Document, fan_index: int) -> str:
    state_after = original_fan_timeline(doc.lines, fan_index)
    rows = []
    rows.append(
        f"{len(doc.blocks)} print block(s) for "
        f"{len({b.object_id for b in doc.blocks})} object(s); "
        f"{doc.object_id_markers} '; OBJECT_ID:' marker(s); "
        f"{len(doc.layer_manifest)} layer manifest(s)"
    )
    rows.append(
        "marker mode: "
        + (
            "start/stop labels (block ends read from the file)"
            if doc.marker_mode == "label"
            else "OBJECT_ID only (block ends INFERRED at the next OBJECT_ID / "
            "CHANGE_LAYER / EXECUTABLE_BLOCK_END)"
        )
    )
    rows.append("")
    rows.append(
        f"{'#':>4}  {'obj':>5}  {'layer':>6}  {'lines':>15}  "
        f"{'fan in':>7}  {'fan out':>7}"
    )
    for block in doc.blocks:
        entry = state_before(state_after, block.start_index)
        exit_state = state_after[block.stop_index]
        rows.append(
            f"{block.ordinal:>4}  {block.object_id:>5}  "
            f"{('-' if block.layer is None else block.layer):>6}  "
            f"{f'{block.start_line}-{block.stop_line}':>15}  "
            f"{('off*' if entry is None else 'S' + format_speed(entry)):>7}  "
            f"{('off*' if exit_state is None else 'S' + format_speed(exit_state)):>7}"
        )
    rows.append("")
    rows.append("* 'off*' = no fan command issued yet; printer power-on default.")

    interleaved = _interleaved_layers(doc)
    if interleaved:
        rows.append("")
        rows.append("Layers where more than one object prints:")
        for layer, ids in interleaved:
            rows.append(f"  layer {layer}: objects {','.join(map(str, ids))}")

    for layer, ids in _reentrant_layers(doc):
        rows.append(
            f"  layer {layer}: object(s) {','.join(map(str, ids))} print in more "
            f"than one separate block on this layer (true interleave)"
        )
    return "\n".join(rows)


def _interleaved_layers(doc: Document) -> List[Tuple[int, List[int]]]:
    per_layer: Dict[int, List[int]] = {}
    for block in doc.blocks:
        if block.layer is None:
            continue
        per_layer.setdefault(block.layer, []).append(block.object_id)
    return [
        (layer, sorted(set(ids)))
        for layer, ids in sorted(per_layer.items())
        if len(set(ids)) > 1
    ]


def _reentrant_layers(doc: Document) -> List[Tuple[int, List[int]]]:
    """Layers where an object is entered, left, and entered again."""
    per_layer: Dict[int, List[int]] = {}
    for block in doc.blocks:
        if block.layer is None:
            continue
        per_layer.setdefault(block.layer, []).append(block.object_id)
    out = []
    for layer, ids in sorted(per_layer.items()):
        repeats = sorted({i for i in ids if ids.count(i) > 1})
        if repeats:
            out.append((layer, repeats))
    return out


def format_plan(plan: Plan, doc: Document) -> str:
    if not plan.insertions and not plan.suppressions:
        return "no edits planned"
    rows = []
    for insertion in sorted(plan.insertions, key=lambda i: (i.index, i.kind != "force")):
        anchor = strip_eol(doc.lines[insertion.index])
        rows.append(f"  after line {insertion.index + 1}: {anchor}")
        rows.append(f"    + {insertion.text}")
    if plan.suppressions:
        rows.append(f"  {len(plan.suppressions)} existing fan command(s) suppressed:")
        for suppression in plan.suppressions:
            rows.append(
                f"    line {suppression.index + 1} (obj "
                f"{suppression.block.object_id}): "
                f"{strip_eol(suppression.original).strip()}"
            )
    return "\n".join(rows)


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------


def read_text(path: str) -> str:
    with open(path, "rb") as handle:
        data = handle.read()
    if b"\x00" in data:
        raise GrisprError(
            f"{path} contains NUL bytes and does not look like plain-text G-code. "
            f"Refusing to modify it.",
            code=EXIT_IO,
        )
    # surrogateescape round-trips any non-UTF-8 bytes (e.g. inside an embedded
    # thumbnail comment) so untouched regions are written back byte-identical.
    return data.decode("utf-8", errors="surrogateescape")


def write_text_atomic(path: str, text: str) -> None:
    """Replace `path` atomically so a crash cannot leave a truncated G-code."""
    directory = os.path.dirname(os.path.abspath(path)) or "."
    handle = tempfile.NamedTemporaryFile(
        mode="wb", dir=directory, prefix=".grispr-", suffix=".tmp", delete=False
    )
    tmp_path = handle.name
    try:
        with handle:
            handle.write(text.encode("utf-8", errors="surrogateescape"))
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(tmp_path, os.stat(path).st_mode & 0o7777)
        except OSError:
            pass
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def strip_previous_run(lines: List[str]) -> Tuple[List[str], int]:
    """Undo a previous Grispr run: drop inserted lines, un-comment suppressions."""
    out: List[str] = []
    removed = 0
    prefix = re.compile(rf"^\s*;\s*{re.escape(SENTINEL)}\s+suppressed:\s?")
    for line in lines:
        body = strip_eol(line)
        eol = "\r" if line.endswith("\r") else ""
        match = prefix.match(body)
        if match:
            out.append(body[match.end():] + eol)
            removed += 1
            continue
        if SENTINEL in body:
            removed += 1
            continue
        out.append(line)
    return out, removed


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_fan_value(raw: str) -> float:
    """Accept 0-255, or a percentage like '60%'."""
    text = raw.strip()
    try:
        if text.endswith("%"):
            percent = float(text[:-1])
            if not 0.0 <= percent <= 100.0:
                raise ValueError
            return int(round(255.0 * percent / 100.0))
        value = int(round(float(text)))
    except ValueError:
        raise GrisprError(
            f"invalid fan value {raw!r}: expected 0-255 or a percentage like 60%",
            code=EXIT_USAGE,
        )
    if not 0 <= value <= 255:
        raise GrisprError(
            f"fan value {value} out of range: expected 0-255", code=EXIT_USAGE
        )
    return value


def collect_targets(args: argparse.Namespace) -> Dict[int, float]:
    targets: Dict[int, float] = {}

    for spec in args.object or []:
        if "=" not in spec:
            raise GrisprError(
                f"--object expects ID=VALUE (e.g. --object 3=255), got {spec!r}",
                code=EXIT_USAGE,
            )
        raw_id, raw_value = spec.split("=", 1)
        if not raw_id.strip().isdigit():
            raise GrisprError(
                f"--object id must be an integer unique label id, got "
                f"{raw_id.strip()!r}",
                code=EXIT_USAGE,
            )
        targets[int(raw_id.strip())] = parse_fan_value(raw_value)

    if args.objects:
        if args.fan is None:
            raise GrisprError(
                "--objects requires --fan to say what speed to force",
                code=EXIT_USAGE,
            )
        value = parse_fan_value(args.fan)
        for chunk in re.split(r"[,\s]+", args.objects.strip()):
            if not chunk:
                continue
            if not chunk.isdigit():
                raise GrisprError(
                    f"--objects expects a comma-separated list of integer ids, got "
                    f"{chunk!r}",
                    code=EXIT_USAGE,
                )
            targets[int(chunk)] = value

    return targets


def parse_layer_range(raw: Optional[str]) -> Optional[Tuple[int, int]]:
    if raw is None:
        return None
    match = re.fullmatch(r"\s*(\d+)\s*(?:-\s*(\d+)\s*)?", raw)
    if not match:
        raise GrisprError(
            f"--layers expects N or N-M, got {raw!r}", code=EXIT_USAGE
        )
    low = int(match.group(1))
    high = int(match.group(2)) if match.group(2) else low
    if high < low:
        raise GrisprError(
            f"--layers range {low}-{high} is inverted", code=EXIT_USAGE
        )
    return (low, high)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="grispr",
        description=(
            "Per-object fan control for sliced Bambu Studio G-code. Injects a "
            "forced fan speed at an object's start marker and restores the "
            "original fan state at its stop marker."
        ),
        epilog=(
            "Bambu Studio appends the sliced file's path as the last argument, so "
            "put your options first: grispr.py --object 3=255 --object 7=40%%"
        ),
    )
    parser.add_argument(
        "gcode",
        nargs="?",
        help=(
            "path to the sliced .gcode file, modified in place. Bambu Studio "
            "supplies this automatically as the final argument."
        ),
    )
    parser.add_argument(
        "--object",
        action="append",
        metavar="ID=VALUE",
        help=(
            "force the fan to VALUE (0-255 or a percentage) for the object with "
            "this unique label id. Repeatable."
        ),
    )
    parser.add_argument(
        "--objects",
        metavar="ID,ID,...",
        help="comma-separated object ids to force, used together with --fan",
    )
    parser.add_argument(
        "--fan", metavar="VALUE", help="fan speed for --objects (0-255 or e.g. 60%%)"
    )
    parser.add_argument(
        "--fan-index",
        type=int,
        default=DEFAULT_FAN_INDEX,
        metavar="N",
        help=(
            "which fan to manage (Bambu: 1 part cooling, 2 aux, 3 chamber). "
            f"Default {DEFAULT_FAN_INDEX}."
        ),
    )
    parser.add_argument(
        "--fan-syntax",
        choices=("auto", "bare", "indexed"),
        default="auto",
        help=(
            "syntax for emitted commands: 'bare' (M106 S255), 'indexed' "
            "(M106 P1 S255), or 'auto' to match the file. Default auto."
        ),
    )
    parser.add_argument(
        "--layers",
        metavar="N[-M]",
        help=(
            "only inject on blocks in this layer range, for per-region rather than "
            "whole-object control"
        ),
    )
    parser.add_argument(
        "--hold",
        action="store_true",
        help=(
            "comment out the slicer's own fan commands inside each targeted object "
            "so the forced value holds for the whole object. WARNING: this also "
            "defeats Bambu's native overhang/bridge fan forcing for that object."
        ),
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help=(
            "print the parsed object/layer block map and exit without modifying "
            "anything. Use this to validate the parser against a real file."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print the planned edits without writing the file",
    )
    parser.add_argument(
        "--backup",
        action="store_true",
        help="write <file>.grispr.bak before modifying",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help=(
            "if the file was already processed by Grispr, undo those edits first "
            "and re-apply instead of aborting"
        ),
    )
    parser.add_argument(
        "--allow-missing",
        action="store_true",
        help=(
            "exit 0 when a requested object id has no print block, instead of "
            "failing. Off by default so a wrong id is never a silent no-op."
        ),
    )
    parser.add_argument(
        "--quiet", action="store_true", help="only print warnings and errors"
    )
    parser.add_argument("--version", action="version", version=f"grispr {VERSION}")
    return parser


def run(argv: Sequence[str]) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv))
    out = sys.stderr if args.quiet else sys.stdout

    def say(message: str) -> None:
        if not args.quiet:
            print(message, file=out)

    if not args.gcode:
        raise GrisprError(
            "no G-code file given. Bambu Studio passes the sliced file's path as "
            "the last argument; pass it explicitly when running by hand.",
            code=EXIT_USAGE,
        )
    if not os.path.isfile(args.gcode):
        raise GrisprError(f"{args.gcode}: no such file", code=EXIT_IO)
    if args.fan_index < 0:
        raise GrisprError("--fan-index must be >= 0", code=EXIT_USAGE)

    layer_range = parse_layer_range(args.layers)
    targets = collect_targets(args)

    if not args.list and not targets:
        raise GrisprError(
            "nothing to do: pass --object ID=VALUE (or --objects with --fan), or "
            "--list to inspect the file.",
            code=EXIT_USAGE,
        )

    text = read_text(args.gcode)
    lines = split_lines(text)

    doc = parse_gcode(lines)

    if args.list:
        print(format_block_map(doc, args.fan_index))
        for warning in doc.warnings:
            print(f"warning: {warning}", file=sys.stderr)
        return EXIT_OK

    if doc.previous_run_lines:
        if not args.force:
            raise GrisprError(
                f"{args.gcode} already contains {len(doc.previous_run_lines)} "
                f"Grispr-inserted line(s) (first at line "
                f"{doc.previous_run_lines[0] + 1}). Re-running would stack "
                f"injections. Re-slice, or pass --force to undo the previous run "
                f"and re-apply.",
                code=EXIT_USAGE,
            )
        lines, removed = strip_previous_run(lines)
        say(f"--force: reverted {removed} line(s) from a previous Grispr run")
        doc = parse_gcode(lines)

    present = {block.object_id for block in doc.blocks}
    missing = sorted(set(targets) - present)
    if missing:
        message = (
            f"requested object id(s) {','.join(map(str, missing))} have no print "
            f"block in {args.gcode}. Objects present: "
            f"{','.join(map(str, sorted(present)))}."
        )
        if not args.allow_missing:
            raise GrisprError(
                message + " Refusing to silently do nothing; pass --allow-missing "
                "to treat this as success.",
                code=EXIT_TARGET_MISSING,
            )
        print(f"warning: {message}", file=sys.stderr)
        targets = {k: v for k, v in targets.items() if k not in missing}
        if not targets:
            say("--allow-missing: no matching objects, file left unchanged")
            return EXIT_OK

    if doc.marker_mode == "object_id" and len({b.object_id for b in doc.blocks}) > 1:
        raise GrisprError(
            "this file has no 'start/stop printing object' markers and carries "
            f"{len({b.object_id for b in doc.blocks})} distinct object ids, so the "
            "end of each object's toolpath can only be guessed. That inference is "
            "verified for the single-object shape only. Re-slice with object "
            "labelling enabled so Bambu emits 'start/stop printing object' "
            "markers, then run again. '--list' still works on this file.",
            code=EXIT_PARSE,
        )

    syntax = (
        detect_fan_syntax(doc.lines, args.fan_index)
        if args.fan_syntax == "auto"
        else args.fan_syntax
    )
    use_m107 = file_uses_m107(doc.lines)

    plan = build_plan(
        doc=doc,
        targets=targets,
        fan_index=args.fan_index,
        syntax=syntax,
        hold=args.hold,
        layer_range=layer_range,
        use_m107=use_m107,
    )

    for warning in doc.warnings:
        print(f"warning: {warning}", file=sys.stderr)
    for note in plan.notes:
        say(f"note: {note}")

    if not plan.insertions and not plan.suppressions:
        raise GrisprError(
            "no edits were produced for the requested objects. This should not "
            "happen once the objects were found; refusing to rewrite the file "
            "with no changes.",
            code=EXIT_TARGET_MISSING,
        )

    say(
        f"{len(plan.touched_blocks)} block(s) across "
        f"{len({b.object_id for b in plan.touched_blocks})} object(s); "
        f"{sum(1 for i in plan.insertions if i.kind == 'force')} forced, "
        f"{sum(1 for i in plan.insertions if i.kind == 'restore')} restored"
        + (f", {len(plan.suppressions)} suppressed" if plan.suppressions else "")
    )

    if args.dry_run:
        say("dry run - planned edits:")
        say(format_plan(plan, doc))
        say(f"{args.gcode} left unchanged")
        return EXIT_OK

    new_lines = apply_plan(doc, plan)
    sentinel_line = (
        f"; {SENTINEL} processed by grispr {VERSION}: "
        f"{' '.join(sorted(f'{k}=S{format_speed(v)}' for k, v in targets.items()))} "
        f"fan_index={args.fan_index} hold={int(args.hold)}"
        + ("\r" if doc.newline == "\r\n" else "")
    )
    # Keep the file's trailing newline: a text file ending in '\n' splits to a
    # final empty element, and the sentinel belongs before it, not after.
    if new_lines and strip_eol(new_lines[-1]) == "":
        new_lines.insert(len(new_lines) - 1, sentinel_line)
    else:
        new_lines.append(sentinel_line)
    new_text = "\n".join(new_lines)

    if args.backup:
        backup_path = args.gcode + ".grispr.bak"
        write_text_atomic(backup_path, text)
        say(f"backup written to {backup_path}")

    write_text_atomic(args.gcode, new_text)
    say(f"{args.gcode} updated in place")
    return EXIT_OK


def main(argv: Optional[Sequence[str]] = None) -> int:
    try:
        return run(sys.argv[1:] if argv is None else argv)
    except GrisprError as error:
        print(f"grispr: error: {error}", file=sys.stderr)
        return error.code
    except BrokenPipeError:
        return EXIT_OK
    except OSError as error:
        print(f"grispr: error: {error}", file=sys.stderr)
        return EXIT_IO


if __name__ == "__main__":
    sys.exit(main())
