#!/usr/bin/env python3
"""nso_3mf - Python writer for the same Bambu Studio project (.3mf) layout that
nso-3mf.js produces in the app, for tools that generate geometry in Python.

Parts written (see nso-3mf.js for the rationale behind each):

    [Content_Types].xml                 OPC part types
    _rels/.rels                         root relationship -> the model part
    3D/3dmodel.model                    core 3MF geometry, millimetres, Z up,
                                        vertices in plate coordinates, one
                                        identity build item per object
    Metadata/project_settings.config    Bambu print/filament settings (JSON)
    Metadata/model_settings.config      Bambu per-object metadata: name and,
                                        new here, identify_id per instance
    Metadata/custom_gcode_per_layer.xml Bambu per-layer pause / custom G-code,
                                        only when at least one entry is given
    Metadata/nso_*.json                 NSO's own bookkeeping, kept out of
                                        project_settings.config on purpose
                                        because Bambu warns on unknown keys

Format evidence:
  * project_settings.config: filament-level keys are single-element arrays of
    strings and keep or drop '%' per key (nso-cooling-profiles.js,
    docs/baked-cooling-settings.md). Print-level keys such as layer_height are
    plain strings -- confirmed in fixtures/3mf/pa_pattern.3mf, a real Bambu
    Studio export ("layer_height": "0.2", "print_sequence": "by layer").
  * custom_gcode_per_layer.xml: the layout in fixtures/3mf/pa_pattern.3mf,
    written by BambuStudio-01.07.03.04:
        <custom_gcodes_per_layer><plate><plate_info id="1"/>
        <layer top_z=".." type=".." extruder=".." color="" extra=".."/>
        <mode value="SingleExtruder"/></plate></custom_gcodes_per_layer>
    type is Bambu's CustomGCode::Type: 0 ColorChange, 1 PausePrint,
    2 ToolChange, 3 Template, 4 Custom. For PausePrint the printer profile's
    machine_pause_gcode ("M400 U1" on every Bambu printer, also in that
    fixture) is what gets emitted and `extra` is the on-screen message; for
    Custom, `extra` IS the G-code.
  * model_settings.config identify_id: Bambu writes one per model_instance
    (fixture value "58"). Whether Bambu honours a caller-supplied value on load
    is not verified (tools/grispr/README.md, limitation 4); it is written so
    the mapping can be checked against the sliced G-code's object labels.

The archive is deterministic: fixed DOS timestamps, fixed entry order, so the
same input always gives byte-identical output (the JS writer does the same).

Stdlib only.
"""
from __future__ import annotations

import json
import zipfile
from typing import Dict, List, Optional, Sequence, Tuple

PART_MODEL = "3D/3dmodel.model"
PART_PROJECT_SETTINGS = "Metadata/project_settings.config"
PART_MODEL_SETTINGS = "Metadata/model_settings.config"
PART_CUSTOM_GCODE = "Metadata/custom_gcode_per_layer.xml"

# Bambu Studio CustomGCode::Type
GCODE_TYPE_COLOR_CHANGE = 0
GCODE_TYPE_PAUSE = 1
GCODE_TYPE_TOOL_CHANGE = 2
GCODE_TYPE_TEMPLATE = 3
GCODE_TYPE_CUSTOM = 4

CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
    ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
    ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n'
    ' <Default Extension="config" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n'
    ' <Default Extension="xml" ContentType="application/xml"/>\n'
    ' <Default Extension="json" ContentType="application/json"/>\n'
    '</Types>\n'
)

RELS = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
    ' <Relationship Target="/3D/3dmodel.model" Id="rel-1" '
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n'
    '</Relationships>\n'
)


def xml_escape(s: object) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&apos;"))


def num(v: float) -> str:
    """6 dp, trailing zeros stripped, no '-0'. Same as nso-3mf.js num()."""
    s = "%.6f" % v
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return "0" if s == "-0" else s


def index_triangle_soup(tris: Sequence[Tuple[Tuple[float, float, float], ...]]):
    """Triangle soup -> (flat vertex list, index triples). Dedup key is the
    6 dp text the XML carries, so vertices that serialise identically share an
    index; index-degenerate triangles are dropped (Bambu flags them)."""
    vertices: List[Tuple[float, float, float]] = []
    triangles: List[Tuple[int, int, int]] = []
    seen: Dict[Tuple[str, str, str], int] = {}
    for tri in tris:
        idx = []
        for p in tri:
            key = (num(p[0]), num(p[1]), num(p[2]))
            i = seen.get(key)
            if i is None:
                i = len(vertices)
                seen[key] = i
                vertices.append((p[0], p[1], p[2]))
            idx.append(i)
        a, b, c = idx
        if a != b and b != c and a != c:
            triangles.append((a, b, c))
    return vertices, triangles


class Object3MF:
    """One 3MF object: a name, an indexed mesh, and the identify_id Bambu's
    per-object tooling (tools/grispr) addresses it by."""

    def __init__(self, name: str, tris, identify_id: Optional[int] = None):
        self.name = name
        self.vertices, self.triangles = index_triangle_soup(tris)
        self.identify_id = identify_id


def build_model_xml(objects: Sequence[Object3MF], application: str = "Nest Optimizer") -> str:
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<model unit="millimeter" xml:lang="en-US" '
           'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
           ' <metadata name="Application">%s</metadata>' % xml_escape(application),
           ' <resources>']
    for i, obj in enumerate(objects):
        out.append('  <object id="%d" type="model">' % (i + 1))
        out.append('   <mesh>')
        out.append('    <vertices>')
        for x, y, z in obj.vertices:
            out.append('     <vertex x="%s" y="%s" z="%s"/>' % (num(x), num(y), num(z)))
        out.append('    </vertices>')
        out.append('    <triangles>')
        for a, b, c in obj.triangles:
            out.append('     <triangle v1="%d" v2="%d" v3="%d"/>' % (a, b, c))
        out.append('    </triangles>')
        out.append('   </mesh>')
        out.append('  </object>')
    out.append(' </resources>')
    out.append(' <build>')
    for i in range(len(objects)):
        out.append('  <item objectid="%d" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>' % (i + 1))
    out.append(' </build>')
    out.append('</model>')
    return "\n".join(out) + "\n"


def build_model_settings(objects: Sequence[Object3MF]) -> str:
    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>']
    for i, obj in enumerate(objects):
        out.append('  <object id="%d">' % (i + 1))
        out.append('    <metadata key="name" value="%s"/>' % xml_escape(obj.name or "object_%d" % (i + 1)))
        out.append('  </object>')
    out.append('  <plate>')
    out.append('    <metadata key="plater_id" value="1"/>')
    out.append('    <metadata key="plater_name" value=""/>')
    for i, obj in enumerate(objects):
        out.append('    <model_instance>')
        out.append('      <metadata key="object_id" value="%d"/>' % (i + 1))
        out.append('      <metadata key="instance_id" value="0"/>')
        if obj.identify_id is not None:
            out.append('      <metadata key="identify_id" value="%d"/>' % obj.identify_id)
        out.append('    </model_instance>')
    out.append('  </plate>')
    out.append('</config>')
    return "\n".join(out) + "\n"


class LayerGcode:
    """One <layer> entry of custom_gcode_per_layer.xml.

    top_z   print_z of the layer the entry fires BEFORE (Bambu's layer-slider
            tick semantics: the code runs at the change to this layer).
    type    GCODE_TYPE_PAUSE or GCODE_TYPE_CUSTOM (others accepted, unused).
    extra   pause message for a pause; the G-code text for a custom entry.
    """

    def __init__(self, top_z: float, type_: int, extra: str = "", extruder: int = 1, color: str = ""):
        self.top_z = top_z
        self.type = type_
        self.extra = extra
        self.extruder = extruder
        self.color = color


def build_custom_gcode_xml(layers: Sequence[LayerGcode], plate_id: int = 1) -> str:
    out = ['<?xml version="1.0" encoding="utf-8"?>',
           '<custom_gcodes_per_layer>',
           '<plate>',
           '<plate_info id="%d"/>' % plate_id]
    for L in sorted(layers, key=lambda L: L.top_z):
        out.append('<layer top_z="%s" type="%d" extruder="%d" color="%s" extra="%s"/>' % (
            num(L.top_z), L.type, L.extruder, xml_escape(L.color), xml_escape(L.extra)))
    out.append('<mode value="SingleExtruder"/>')
    out.append('</plate>')
    out.append('</custom_gcodes_per_layer>')
    return "\n".join(out) + "\n"


def serialize_project_settings(values: Dict[str, object]) -> str:
    """JSON with the exact shapes Bambu writes: whatever the caller passes, so
    the caller decides list-vs-scalar per key (see the module docstring)."""
    return json.dumps(values, indent=4, ensure_ascii=False) + "\n"


def build_3mf(path, objects: Sequence[Object3MF], project_settings_text: str,
              custom_gcode: Sequence[LayerGcode] = (),
              extra_parts: Optional[Dict[str, str]] = None,
              application: str = "Nest Optimizer") -> List[str]:
    """Write the archive. Returns the list of part names in the order written."""
    if not objects:
        raise ValueError("No objects to export")
    entries: List[Tuple[str, str]] = [
        ("[Content_Types].xml", CONTENT_TYPES),
        ("_rels/.rels", RELS),
        (PART_MODEL, build_model_xml(objects, application)),
        (PART_PROJECT_SETTINGS, project_settings_text),
        (PART_MODEL_SETTINGS, build_model_settings(objects)),
    ]
    if custom_gcode:
        entries.append((PART_CUSTOM_GCODE, build_custom_gcode_xml(custom_gcode)))
    for name, text in sorted((extra_parts or {}).items()):
        entries.append((name, text))
    # Fixed timestamp (the ZIP epoch, like nso-3mf.js) for byte-identical output.
    with zipfile.ZipFile(path, "w") as zf:
        for name, text in entries:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0
            zf.writestr(info, text.encode("utf-8"))
    return [name for name, _ in entries]
