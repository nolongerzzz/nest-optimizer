"""Synthetic Bambu-style G-code fixtures for the Grispr test suite.

These mimic the marker pattern Bambu Studio emits around object toolpaths. They
are deliberately small so failures are readable, but they reproduce the
structural cases that matter: several objects interleaving inside one layer, an
object re-entered twice on the same layer, slicer-emitted fan commands inside an
object block (Bambu's native overhang forcing), and a range of malformed files.
"""

from __future__ import annotations

from typing import Iterable, List, Optional, Sequence, Tuple

HEADER = [
    "; HEADER_BLOCK_START",
    "; BambuStudio 01.09.00.70",
    "; model printing time: 42m 17s; total estimated time: 48m 3s",
    "; total layer number: 3",
    "; HEADER_BLOCK_END",
    "",
    "; CONFIG_BLOCK_START",
    "; enable_overhang_bridge_fan = 1",
    "; overhang_fan_threshold = 95%",
    "; overhang_fan_speed = 100",
    "; CONFIG_BLOCK_END",
    "",
    "M73 P0 R48",
    "M190 S60",
    "M109 S220",
    "G28",
    "G90",
    "M83",
]

FOOTER = [
    "M107",
    "M104 S0",
    "M140 S0",
    "G28 X0 Y0",
    "M84",
    "; EXECUTABLE_BLOCK_END",
]


def object_block(object_id: int, body: Optional[Sequence[str]] = None) -> List[str]:
    """One object print block, exactly as Bambu brackets it."""
    if body is None:
        body = [
            f"G1 X{10 + object_id} Y{10 + object_id} F9000",
            f"G1 X{20 + object_id} Y{20 + object_id} E0.5 F1800",
        ]
    return [
        f"; OBJECT_ID: {object_id}",
        f"; start printing object, unique label id: {object_id}",
        *body,
        f"; stop printing object, unique label id: {object_id}",
    ]


def layer(
    number: int,
    sequence: Sequence[object],
    z: Optional[float] = None,
) -> List[str]:
    """One layer.

    `sequence` holds object ids (int) or (object_id, body) pairs, in print order.
    The same id may appear more than once to model an object that is left and
    re-entered on the same layer.
    """
    ids: List[int] = []
    blocks: List[str] = []
    for item in sequence:
        if isinstance(item, tuple):
            object_id, body = item
        else:
            object_id, body = item, None
        ids.append(int(object_id))
        blocks.extend(object_block(int(object_id), body))

    unique = sorted(set(ids))
    manifest = ",".join(str(i) for i in unique)
    height = z if z is not None else round(0.2 * number, 2)
    return [
        "; CHANGE_LAYER",
        f"; Z_HEIGHT: {height}",
        f"; layer num/total_layer_count: {number}/3",
        f"; object ids of layer {number} start: {manifest}",
        f"G1 Z{height} F600",
        *blocks,
        f"; object ids of layer {number} end: {manifest}",
    ]


def assemble(layers: Iterable[Sequence[str]], header: Optional[Sequence[str]] = None,
             footer: Optional[Sequence[str]] = None) -> str:
    parts: List[str] = list(HEADER if header is None else header)
    for block in layers:
        parts.extend(block)
    parts.extend(FOOTER if footer is None else footer)
    return "\n".join(parts) + "\n"


# --- well-formed fixtures ---------------------------------------------------


def single_object() -> str:
    """One object, three layers. The simplest correct case."""
    return assemble([layer(n, [1]) for n in (1, 2, 3)])


def two_objects() -> str:
    """Two objects, both printed on every layer, no interleave within a layer."""
    return assemble([layer(n, [1, 2]) for n in (1, 2, 3)])


def interleaved_three() -> str:
    """Three objects interleaving, including an object re-entered on one layer.

    Layer 2 prints 1, 2, 3, 1, 2 - so object 1 and object 2 each get two separate
    print blocks on the same layer. This is the case that breaks any parser
    assuming one block per object per layer.
    """
    return assemble(
        [
            layer(1, [1, 2, 3]),
            layer(2, [1, 2, 3, 1, 2]),
            layer(3, [3, 1, 2]),
        ]
    )


def interleaved_with_slicer_fan() -> str:
    """Interleaved objects where the slicer sets the fan globally and per-object.

    Object 2's block on layer 2 contains its own M106 S255 - standing in for
    Bambu's native overhang/bridge fan forcing. A correct restore has to put the
    fan back to *that* value at the stop marker, not to whatever was active
    before the block started.
    """
    overhang_body = [
        "G1 X30 Y30 F9000",
        ";TYPE:Overhang perimeter",
        "M106 S255",
        "G1 X40 Y40 E0.8 F1200",
    ]
    return assemble(
        [
            [
                "; CHANGE_LAYER",
                "; layer num/total_layer_count: 1/3",
                "; object ids of layer 1 start: 1,2,3",
                "M106 S102",
                *object_block(1),
                *object_block(2),
                *object_block(3),
                "; object ids of layer 1 end: 1,2,3",
            ],
            [
                "; CHANGE_LAYER",
                "; layer num/total_layer_count: 2/3",
                "; object ids of layer 2 start: 1,2,3",
                *object_block(1),
                *object_block(2, overhang_body),
                *object_block(3),
                "; object ids of layer 2 end: 1,2,3",
            ],
            [
                "; CHANGE_LAYER",
                "; layer num/total_layer_count: 3/3",
                "; object ids of layer 3 start: 1,2,3",
                "M106 S153",
                *object_block(3),
                *object_block(1),
                *object_block(2),
                "; object ids of layer 3 end: 1,2,3",
            ],
        ]
    )


def aux_fan() -> str:
    """Part cooling (P1/bare) and aux fan (P2) commands side by side."""
    return assemble(
        [
            [
                "; CHANGE_LAYER",
                "; layer num/total_layer_count: 1/3",
                "; object ids of layer 1 start: 1,2",
                "M106 P1 S128",
                "M106 P2 S80",
                *object_block(1),
                *object_block(2),
                "; object ids of layer 1 end: 1,2",
            ]
        ]
    )


def crlf_two_objects() -> str:
    """Same as two_objects() but with Windows line endings."""
    return two_objects().replace("\n", "\r\n")


def no_layer_markers() -> str:
    """Object markers present, but no layer markers at all."""
    return assemble([[*object_block(1), *object_block(2)]])


# --- malformed fixtures -----------------------------------------------------


def unclosed_start() -> str:
    """Object 2 is opened but never closed."""
    lines = [
        "; CHANGE_LAYER",
        "; object ids of layer 1 start: 1,2",
        *object_block(1),
        "; OBJECT_ID: 2",
        "; start printing object, unique label id: 2",
        "G1 X30 Y30 E0.4 F1800",
        "; object ids of layer 1 end: 1,2",
    ]
    return assemble([lines])


def orphan_stop() -> str:
    """A stop marker with no matching start."""
    lines = [
        "; CHANGE_LAYER",
        "; object ids of layer 1 start: 1",
        "G1 X10 Y10 E0.2 F1800",
        "; stop printing object, unique label id: 1",
        "; object ids of layer 1 end: 1",
    ]
    return assemble([lines])


def nested_start() -> str:
    """Object 2 starts while object 1 is still open."""
    lines = [
        "; CHANGE_LAYER",
        "; object ids of layer 1 start: 1,2",
        "; start printing object, unique label id: 1",
        "G1 X10 Y10 E0.2 F1800",
        "; start printing object, unique label id: 2",
        "G1 X20 Y20 E0.2 F1800",
        "; stop printing object, unique label id: 2",
        "; stop printing object, unique label id: 1",
        "; object ids of layer 1 end: 1,2",
    ]
    return assemble([lines])


def mismatched_stop() -> str:
    """Object 1 is closed by a stop marker naming object 2."""
    lines = [
        "; CHANGE_LAYER",
        "; object ids of layer 1 start: 1",
        "; start printing object, unique label id: 1",
        "G1 X10 Y10 E0.2 F1800",
        "; stop printing object, unique label id: 2",
        "; object ids of layer 1 end: 1",
    ]
    return assemble([lines])


def no_markers() -> str:
    """Plain G-code from a slicer that does not label objects at all."""
    return "\n".join(
        [
            "; generated by some other slicer",
            "M190 S60",
            "M109 S210",
            "G28",
            ";LAYER:0",
            "G1 Z0.2 F600",
            "M106 S255",
            "G1 X10 Y10 E0.2 F1800",
            "G1 X20 Y20 E0.4 F1800",
            ";LAYER:1",
            "G1 X30 Y30 E0.6 F1800",
            "M107",
            "M84",
        ]
    ) + "\n"


def object_id_markers_only() -> str:
    """'; OBJECT_ID:' present but no start/stop label pairs."""
    return "\n".join(
        [
            "; HEADER_BLOCK_START",
            "; HEADER_BLOCK_END",
            "; OBJECT_ID: 1",
            "G1 X10 Y10 E0.2 F1800",
            "; OBJECT_ID: 2",
            "G1 X20 Y20 E0.2 F1800",
            "M84",
        ]
    ) + "\n"


def manifest_mismatch() -> str:
    """Layer manifest claims object 9 prints on layer 1, but no block exists."""
    lines = [
        "; CHANGE_LAYER",
        "; layer num/total_layer_count: 1/1",
        "; object ids of layer 1 start: 1,9",
        *object_block(1),
        "; object ids of layer 1 end: 1,9",
    ]
    return assemble([lines])


WELL_FORMED = {
    "single_object": single_object,
    "two_objects": two_objects,
    "interleaved_three": interleaved_three,
    "interleaved_with_slicer_fan": interleaved_with_slicer_fan,
    "aux_fan": aux_fan,
    "crlf_two_objects": crlf_two_objects,
    "no_layer_markers": no_layer_markers,
    "manifest_mismatch": manifest_mismatch,
}

MALFORMED = {
    "unclosed_start": unclosed_start,
    "orphan_stop": orphan_stop,
    "nested_start": nested_start,
    "mismatched_stop": mismatched_stop,
    "no_markers": no_markers,
    "object_id_markers_only": object_id_markers_only,
}

ALL = {**WELL_FORMED, **MALFORMED}


def write_all(directory: str) -> List[str]:
    """Write every fixture to `directory` as .gcode files. Returns the paths."""
    import os

    os.makedirs(directory, exist_ok=True)
    paths = []
    for name, builder in ALL.items():
        path = os.path.join(directory, f"{name}.gcode")
        with open(path, "w", newline="") as handle:
            handle.write(builder())
        paths.append(path)
    return paths


if __name__ == "__main__":
    import sys

    target = sys.argv[1] if len(sys.argv) > 1 else "fixtures_out"
    for path in write_all(target):
        print(path)
