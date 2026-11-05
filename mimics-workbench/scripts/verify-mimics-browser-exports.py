#!/usr/bin/env python3
"""Independent, standard-library oracle for synthetic browser export evidence.

No application parser, exporter, JavaScript runtime or third-party package is used.
Project v1 schema is the input contract; geometry and file formats are parsed here.
"""
import argparse
from collections import Counter
import gzip
import hashlib
import json
import math
from pathlib import Path
import struct
import sys
import tempfile
import zipfile

MAX_ENTRY = 512 * 1024 * 1024
MAX_TOTAL = 1024 * 1024 * 1024
MAX_RESLICE_TRANSFORM = 64 * 1024
TRANSFORM_HEADINGS = (
    "old-world-mm -> new-world-mm (coordinate-system change T)",
    "new-world-mm -> old-world-mm (inverse T)",
    "new-IJK-sample-center -> old-IJK-sample-center (Aold^-1 * inverse(T) * Anew)",
)
DATATYPES = {2: ("B", 8), 4: ("h", 16), 8: ("i", 32), 16: ("f", 32),
             64: ("d", 64), 256: ("b", 8), 512: ("H", 16), 768: ("I", 32),
             1024: ("q", 64), 1280: ("Q", 64)}


class VerificationError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def close(a, b, absolute=1e-6, relative=1e-7):
    return math.isfinite(a) and math.isfinite(b) and math.isclose(a, b, abs_tol=absolute, rel_tol=relative)


def numeric(data, code, label, endian="<"):
    size = struct.calcsize(code)
    require(len(data) % size == 0, f"{label}: byte length is not divisible by {size}")
    values = [item[0] for item in struct.iter_unpack(endian + code, data)]
    require(all(math.isfinite(v) for v in values), f"{label}: non-finite numeric value")
    return values


def statistics(values):
    return {"count": len(values), "min": min(values) if values else None,
            "max": max(values) if values else None,
            "mean": math.fsum(values) / len(values) if values else None,
            "nonzero_count": sum(v != 0 for v in values)}


def determinant(matrix):
    a, b, c = matrix
    return (a[0] * (b[1] * c[2] - b[2] * c[1])
            - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0]))


def nifti_header(data):
    require(len(data) >= 348, "NIfTI: truncated header")
    endian = "<" if struct.unpack_from("<i", data)[0] == 348 else ">"
    get = lambda code, offset: struct.unpack_from(endian + code, data, offset)[0]
    require(get("i", 0) == 348, "NIfTI: not a NIfTI-1 header")
    require(data[344:348] == b"n+1\0", "NIfTI: only single-file n+1 images are supported")
    rank = get("h", 40)
    dimensions = [get("h", 42 + 2 * i) for i in range(7)]
    require(3 <= rank <= 7 and all(d > 0 for d in dimensions[:3]), "NIfTI: invalid dimensions")
    require(all(d == 1 for d in dimensions[3:rank]), "NIfTI: non-singleton time/channel axis")
    dims = dimensions[:3]
    count = math.prod(dims)
    require(count <= 128 * 1024 * 1024, "NIfTI: voxel count exceeds verifier budget")
    datatype, bitpix = get("h", 70), get("h", 72)
    require(datatype in DATATYPES, f"NIfTI: unsupported datatype {datatype}")
    require(bitpix == DATATYPES[datatype][1], "NIfTI: datatype/bitpix mismatch")
    offset = get("f", 108)
    require(math.isfinite(offset) and offset.is_integer() and offset >= 352, "NIfTI: invalid voxel offset")
    slope, intercept = get("f", 112), get("f", 116)
    if slope == 0:
        slope, intercept = 1.0, 0.0
    require(math.isfinite(slope) and math.isfinite(intercept), "NIfTI: invalid intensity scaling")
    pixdim = [get("f", 76 + 4 * i) for i in range(8)]
    require(all(math.isfinite(v) and abs(v) > 0 for v in pixdim[1:4]), "NIfTI: invalid pixdim")
    qform, sform = get("h", 252), get("h", 254)
    if sform > 0:
        affine = [[get("f", 280 + 16 * r + 4 * c) for c in range(4)] for r in range(3)]
        method = "sform"
    elif qform > 0:
        b, c, d = [get("f", offset) for offset in (256, 260, 264)]
        require(all(math.isfinite(v) for v in (b, c, d, pixdim[0])), "NIfTI: invalid quaternion")
        squared = b * b + c * c + d * d
        if squared > 1:
            length = math.sqrt(squared)
            b, c, d = b / length, c / length, d / length
            a = 0.0
        else:
            a = math.sqrt(1 - squared)
        rotation = [[a*a+b*b-c*c-d*d, 2*(b*c-a*d), 2*(b*d+a*c)],
                    [2*(b*c+a*d), a*a+c*c-b*b-d*d, 2*(c*d-a*b)],
                    [2*(b*d-a*c), 2*(c*d+a*b), a*a+d*d-c*c-b*b]]
        scales = [abs(pixdim[1]), abs(pixdim[2]), abs(pixdim[3]) * (-1 if pixdim[0] < 0 else 1)]
        affine = [[rotation[r][c] * scales[c] for c in range(3)] + [get("f", 268 + r * 4)] for r in range(3)]
        method = "qform"
    else:
        affine = [[abs(pixdim[r+1]) if r == c else 0.0 for c in range(3)] + [0.0] for r in range(3)]
        method = "pixdim-fallback-orientation-unspecified"
    require(all(math.isfinite(v) for row in affine for v in row), "NIfTI: non-finite affine")
    require(abs(determinant(affine)) > 0, "NIfTI: singular affine")
    unit_code = data[123] & 7
    unit, scale = {1: ("metre", 1000), 2: ("millimetre", 1), 3: ("micrometre", .001)}.get(unit_code, ("unknown", None))
    affine_mm = [[v * scale for v in row] for row in affine] if scale is not None else None
    return {"endianness": "little" if endian == "<" else "big", "dims": dims,
            "voxel_count": count, "datatype": datatype, "bitpix": bitpix,
            "intent_code": get("h", 68), "voxel_offset": int(offset), "slope": slope, "intercept": intercept,
            "qform_code": qform, "sform_code": sform, "affine_method": method,
            "sform_native": [[get("f", 280 + 16*r + 4*c) for c in range(4)] for r in range(3)] if sform > 0 else None,
            "affine_native": affine, "affine_mm": affine_mm,
            "pixdim_native": [abs(v) for v in pixdim[1:4]], "spatial_unit_code": unit_code, "spatial_unit": unit}


def read_file(path):
    path = Path(path)
    require(path.stat().st_size <= MAX_ENTRY, f"{path}: file exceeds verifier budget")
    if path.suffix.lower() == ".gz":
        with gzip.open(path, "rb") as stream:
            data = stream.read(MAX_ENTRY + 1)
        require(len(data) <= MAX_ENTRY, "gzip: uncompressed file exceeds verifier budget")
        return data
    return path.read_bytes()


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def inspect_nifti(path):
    data = read_file(path)
    require(len(data) >= 352, "NIfTI: file shorter than single-file preamble")
    header = nifti_header(data)
    code, bits = DATATYPES[header["datatype"]]
    end = header["voxel_offset"] + header["voxel_count"] * bits // 8
    require(end <= len(data), "NIfTI: truncated voxel buffer")
    raw = numeric(data[header["voxel_offset"]:end], code, "NIfTI voxels", "<" if header["endianness"] == "little" else ">")
    values = [v * header["slope"] + header["intercept"] for v in raw]
    require(all(math.isfinite(v) for v in values), "NIfTI: scaled values are non-finite")
    report = {**header, "byte_length": len(data), "trailing_bytes": len(data) - end,
              "raw_statistics": statistics(raw), "scaled_statistics": statistics(values)}
    return report, {"header": header, "values": values}


def bounds(points):
    if not points:
        return None
    return {"min": [min(p[a] for p in points) for a in range(3)],
            "max": [max(p[a] for p in points) for a in range(3)]}


def edge_topology(faces):
    edges, directions = Counter(), Counter()
    for a, b, c in faces:
        for start, end in ((a, b), (b, c), (c, a)):
            if start == end:
                continue
            edge = (min(start, end), max(start, end))
            edges[edge] += 1
            directions[edge] += 1 if start < end else -1
    return {"edge_count": len(edges), "boundary_edges": sum(v == 1 for v in edges.values()),
            "non_manifold_edges": sum(v > 2 for v in edges.values()),
            "orientation_conflict_edges": sum(v == 2 and directions[e] != 0 for e, v in edges.items())}


def triangle_digest(points, oriented):
    # Normalise signed zero. Inputs are already float32; facet/vertex ordering may differ.
    p = [tuple(0.0 if v == 0 else v for v in point) for point in points]
    ordered = min(tuple(p[i:] + p[:i]) for i in range(3)) if oriented else tuple(sorted(p))
    return hashlib.sha256(struct.pack("<9f", *(v for point in ordered for v in point))).digest()


def mesh_summary(vertices, faces):
    require(all(len(p) == 3 and all(math.isfinite(v) for v in p) for p in vertices), "mesh: invalid vertex")
    require(all(len(f) == 3 and all(type(i) is int and 0 <= i < len(vertices) for i in f) for f in faces), "mesh: invalid triangle index")
    unique, mapping, lookup = [], [], {}
    for point in vertices:
        key = tuple(point)
        if key not in lookup:
            lookup[key] = len(unique)
            unique.append(key)
        mapping.append(lookup[key])
    welded_faces = [tuple(mapping[i] for i in face) for face in faces]
    used = {i for f in faces for i in f}
    areas, volumes, plain_hashes, oriented_hashes = [], [], [], []
    origin = vertices[0] if vertices else (0, 0, 0)
    degenerate = 0
    for face in faces:
        points = [vertices[i] for i in face]
        a, b, c = points
        u, v = [b[k] - a[k] for k in range(3)], [c[k] - a[k] for k in range(3)]
        cross = (u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0])
        area = math.hypot(*cross) / 2
        degenerate += area == 0
        areas.append(area)
        a, b, c = ([point[k] - origin[k] for k in range(3)] for point in points)
        volumes.append((a[0]*(b[1]*c[2]-b[2]*c[1]) + a[1]*(b[2]*c[0]-b[0]*c[2]) + a[2]*(b[0]*c[1]-b[1]*c[0])) / 6)
        plain_hashes.append(triangle_digest(points, False))
        oriented_hashes.append(triangle_digest(points, True))
    indexed, welded = edge_topology(faces), edge_topology(welded_faces)
    closed = bool(faces) and not degenerate and all(welded[key] == 0 for key in ("boundary_edges", "non_manifold_edges", "orientation_conflict_edges"))
    signed_volume = math.fsum(volumes)
    return {"vertex_count": len(vertices), "referenced_vertex_count": len(used),
            "unique_coordinate_vertex_count": len(unique), "triangle_count": len(faces),
            "index_range": [min(used), max(used)] if used else None, "bounds_mm": bounds(vertices),
            "referenced_bounds_mm": bounds([vertices[i] for i in used]),
            "topology_indexed": indexed, "topology_welded_exact": welded,
            "degenerate_triangles": degenerate, "surface_area_mm2": math.fsum(areas),
            "closed_and_consistently_oriented_edges": closed,
            "signed_volume_mm3": signed_volume, "enclosed_volume_mm3": abs(signed_volume) if closed else None,
            "triangle_fingerprint": hashlib.sha256(b"".join(sorted(plain_hashes))).hexdigest(),
            "oriented_triangle_fingerprint": hashlib.sha256(b"".join(sorted(oriented_hashes))).hexdigest()}


def inspect_stl(path):
    data = read_file(path)
    require(len(data) >= 84, "binary STL: truncated header")
    count = struct.unpack_from("<I", data, 80)[0]
    require(len(data) == 84 + count * 50, "binary STL: triangle count/byte length mismatch")
    vertices, faces, lookup, attributes = [], [], {}, Counter()
    zero_normals = disagreeing_normals = 0
    for n in range(count):
        record = struct.unpack_from("<12fH", data, 84 + 50*n)
        require(all(math.isfinite(v) for v in record[:12]), "binary STL: non-finite facet")
        normal, points = record[:3], [tuple(record[3+3*k:6+3*k]) for k in range(3)]
        face = []
        for point in points:
            if point not in lookup:
                lookup[point] = len(vertices)
                vertices.append(point)
            face.append(lookup[point])
        faces.append(tuple(face))
        u, v = ([points[j][k] - points[0][k] for k in range(3)] for j in (1, 2))
        geometric = (u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0])
        length, normal_length = math.hypot(*geometric), math.hypot(*normal)
        zero_normals += normal_length == 0
        if length and normal_length and sum(a*b for a, b in zip(geometric, normal)) / length / normal_length < .9999:
            disagreeing_normals += 1
        attributes[record[12]] += 1
    summary = mesh_summary(vertices, faces)
    return {**summary, "byte_length": len(data), "stored_vertex_records": 3*count,
            "welding": "exact decoded float32 coordinate tuples; no tolerance welding",
            "header_text": data[:80].rstrip(b"\0").decode("ascii", errors="replace"),
            "zero_facet_normals": zero_normals, "normals_disagreeing_with_winding": disagreeing_normals,
            "attribute_counts": dict(attributes)}, summary


def mask_summary(data, dims, affine_mm):
    require(len(data) == math.prod(dims), "project Mask: buffer length/dimensions mismatch")
    require(all(v in (0, 1) for v in data), "project Mask: non-binary membership")
    count, low, high = 0, [math.inf]*3, [-math.inf]*3
    for i, value in enumerate(data):
        if not value:
            continue
        count += 1
        point = (i % dims[0], i // dims[0] % dims[1], i // (dims[0]*dims[1]))
        for a in range(3):
            low[a], high[a] = min(low[a], point[a]), max(high[a], point[a])
    return {"voxel_count": len(data), "member_count": count,
            "value_range": [min(data), max(data)] if data else None,
            "member_voxel_bounds": {"min": low, "max": high} if count else None,
            "member_volume_mm3": count * abs(determinant(affine_mm)) if affine_mm is not None else None}


def matrix_close(a, b):
    return isinstance(a, list) and len(a) == 3 and all(isinstance(row, list) and len(row) == 4 for row in a) and all(close(a[r][c], b[r][c]) for r in range(3) for c in range(4))


def homogeneous(matrix):
    require(isinstance(matrix, list) and len(matrix) in (3, 4)
            and all(isinstance(row, list) and len(row) == 4 for row in matrix),
            "transform: expected a 3x4 or 4x4 matrix")
    require(all(type(value) in (int, float) and math.isfinite(value) for row in matrix for value in row),
            "transform: non-finite/non-numeric matrix entry")
    if len(matrix) == 4:
        require(matrix[3] == [0, 0, 0, 1], "transform: invalid homogeneous last row")
    return [list(row) for row in matrix[:3]] + [[0., 0., 0., 1.]]


def matrix_product(left, right):
    return [[math.fsum(left[r][k] * right[k][c] for k in range(4)) for c in range(4)] for r in range(4)]


def matrix_residual(left, right):
    return max(abs(left[r][c] - right[r][c]) for r in range(4) for c in range(4))


def inverse_affine(matrix):
    matrix = homogeneous(matrix)
    a, b, c = [row[:3] for row in matrix[:3]]
    det = determinant([a, b, c])
    require(math.isfinite(det) and det != 0, "transform: singular affine")
    inverse = [[(b[1]*c[2]-b[2]*c[1])/det, (a[2]*c[1]-a[1]*c[2])/det, (a[1]*b[2]-a[2]*b[1])/det],
               [(b[2]*c[0]-b[0]*c[2])/det, (a[0]*c[2]-a[2]*c[0])/det, (a[2]*b[0]-a[0]*b[2])/det],
               [(b[0]*c[1]-b[1]*c[0])/det, (a[1]*c[0]-a[0]*c[1])/det, (a[0]*b[1]-a[1]*b[0])/det]]
    result = [row + [-math.fsum(row[k] * matrix[k][3] for k in range(3))] for row in inverse]
    require(all(math.isfinite(v) for row in result for v in row), "transform: inverse exceeds finite numeric range")
    return result + [[0., 0., 0., 1.]]


def inspect_reslice_transform(text):
    """Parse the documented application text independently, not as opaque metadata."""
    require(isinstance(text, str) and bool(text.strip()), "resliceTransform: expected nonempty text")
    encoded = text.encode("utf-8", errors="strict")
    require(len(encoded) <= MAX_RESLICE_TRANSFORM, "resliceTransform: exceeds 64 KiB UTF-8 budget")
    lines = [line.strip() for line in text.splitlines()]
    require(lines and lines[0] == "Deepmark Reslice Project coordinate transforms (independent application format; not a vendor TXT format).",
            "resliceTransform: unsupported transform text format")
    flags = [line for line in lines if line.startswith("Update CS:")]
    require(len(flags) == 1 and flags[0] in ("Update CS: on.", "Update CS: off."),
            "resliceTransform: missing/ambiguous Update CS flag")
    require("Coordinates use millimetres. Homogeneous column vectors; matrices printed row-major." in lines,
            "resliceTransform: missing coordinate units/layout declaration")
    require(any("sample centers" in line for line in lines), "resliceTransform: missing sample-center convention")
    matrices = []
    for heading in TRANSFORM_HEADINGS:
        require(lines.count(heading) == 1, f"resliceTransform: missing/duplicate matrix heading {heading}")
        offset = lines.index(heading) + 1
        require(offset + 4 <= len(lines), "resliceTransform: truncated 4x4 matrix")
        try:
            rows = [[float(value) for value in line.split()] for line in lines[offset:offset+4]]
        except ValueError as error:
            raise VerificationError("resliceTransform: invalid numeric matrix text") from error
        require(len(rows) == 4 and all(len(row) == 4 for row in rows), "resliceTransform: matrix must contain four rows of four values")
        matrices.append(homogeneous(rows))
    t, inverse, sampling = matrices
    unit = [[float(r == c) for c in range(4)] for r in range(4)]
    residual = max(matrix_residual(matrix_product(t, inverse), unit), matrix_residual(matrix_product(inverse, t), unit))
    require(residual <= 1e-8, "resliceTransform: world matrices are not mutual inverses")
    for label, matrix in (("T", t), ("inverse T", inverse)):
        rotation = [row[:3] for row in matrix[:3]]
        require(all(close(math.fsum(rotation[r][k]*rotation[c][k] for k in range(3)), float(r == c), 1e-8)
                    for r in range(3) for c in range(3)) and close(determinant(rotation), 1., 1e-8),
                f"resliceTransform: {label} is not a proper rigid coordinate transform")
    inverse_affine(sampling)
    updated = flags[0] == "Update CS: on."
    if not updated:
        require(matrix_residual(t, unit) <= 1e-8 and matrix_residual(inverse, unit) <= 1e-8,
                "resliceTransform: Update CS off has a nonidentity world transform")
    return {"utf8_byte_length": len(encoded), "sha256": hashlib.sha256(encoded).hexdigest(),
            "update_cs": updated, "old_world_mm_to_new_world_mm": t,
            "new_world_mm_to_old_world_mm": inverse, "new_ijk_to_old_ijk": sampling,
            "world_inverse_max_abs_residual": residual,
            "source_sampling_map_checked": "requires an independently supplied source project affine"}


def inspect_project(path):
    require(Path(path).stat().st_size <= MAX_ENTRY, "project ZIP: archive exceeds verifier budget")
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        require(len(names) <= 10000 and len(names) == len(set(names)), "project ZIP: duplicate/excessive entries")
        require(all(not entry.is_dir() and not entry.flag_bits & 1 and entry.file_size <= MAX_ENTRY for entry in entries), "project ZIP: directory/encrypted/oversized entry")
        require(sum(entry.file_size for entry in entries) <= MAX_TOTAL, "project ZIP: total uncompressed size exceeds verifier budget")
        require(all(not name.startswith("/") and "\\" not in name and ":" not in name and ".." not in name.split("/") for name in names), "project ZIP: unsafe path")
        require("project.json" in names and archive.getinfo("project.json").file_size <= 8*1024*1024, "project ZIP: missing/oversized descriptor")
        require(archive.testzip() is None, "project ZIP: CRC check failed")
        metadata = json.loads(archive.read("project.json"), parse_constant=lambda value: (_ for _ in ()).throw(VerificationError(f"JSON non-finite constant {value}")))
        require(isinstance(metadata, dict), "project ZIP: descriptor is not an object")
        require(metadata.get("format") == "deepmark-mimics-workbench" and metadata.get("version") == 1 and metadata.get("endianness") == "little", "project ZIP: unsupported schema")
        vm, project = metadata["volume"], metadata["project"]
        require(isinstance(vm, dict) and isinstance(project, dict), "project ZIP: missing volume/project objects")
        dims = vm["dims"]
        require(isinstance(dims, list) and len(dims) == 3 and all(type(d) is int and d > 0 for d in dims), "project: invalid dimensions")
        count = math.prod(dims)
        require(count <= 128*1024*1024, "project: voxel count exceeds verifier budget")
        referenced = {"project.json"}
        def take(name, size=None):
            require(isinstance(name, str) and name in names, f"project: missing referenced buffer {name}")
            referenced.add(name)
            data = archive.read(name)
            require(size is None or len(data) == size, f"project: wrong buffer byte length {name}")
            return data
        transform = None
        if "resliceTransform" in project:
            transform = inspect_reslice_transform(project["resliceTransform"])
            expected = project["resliceTransform"].encode("utf-8")
            require(take("reslice-transform.txt", len(expected)) == expected,
                    "project: reslice-transform.txt does not exactly match declared metadata")
        header = nifti_header(take("image/header.bin", 348))
        image_data = take("image/values.f32", count*4)
        values = numeric(image_data, "f", "project image")
        require(header["dims"] == dims, "project: header dimensions disagree with JSON")
        require(vm["little"] == (header["endianness"] == "little"), "project: source byte order disagrees with header")
        require(matrix_close(vm["affine"], header["affine_native"]), "project: affine disagrees with header")
        expected_spacing = [math.hypot(*(row[c] for row in header["affine_mm"] or header["affine_native"])) for c in range(3)]
        require(len(vm["spacing"]) == 3 and all(close(a, b, 1e-5, 1e-6) for a, b in zip(vm["spacing"], expected_spacing)), "project: spacing disagrees with affine/unit")
        require(vm["unit"] == ("mm" if header["affine_mm"] is not None else "影像单位"), "project: unit label disagrees with header")
        value_stats = statistics(values)
        require(close(vm["min"], value_stats["min"], 1e-5, 1e-6) and close(vm["max"], value_stats["max"], 1e-5, 1e-6), "project: intensity range disagrees with values")
        masks, parts, coverage = [], [], bytearray(count)
        for i, mask in enumerate(project["masks"]):
            require(mask["path"] == f"masks/{i}.u8", "project: unexpected Mask path")
            data = take(mask["path"], count)
            summary = {"id": mask["id"], "name": mask["name"], "revision": mask["revision"], "threshold": mask["threshold"], **mask_summary(data, dims, header["affine_mm"])}
            for j, value in enumerate(data):
                if value and coverage[j] < 2:
                    coverage[j] += 1
            masks.append({"metadata": mask, "data": data, "summary": summary})
        for i, part in enumerate(project["parts"]):
            require(part["positions"] == f"parts/{i}.positions.f32" and part["indices"] == f"parts/{i}.indices.u32", "project: unexpected Part path")
            position_data, index_data = take(part["positions"]), take(part["indices"])
            positions = numeric(position_data, "f", "project Part positions")
            indices = numeric(index_data, "I", "project Part indices")
            require(len(positions) % 3 == 0 and len(indices) % 3 == 0, "project Part: incomplete vertex/triangle")
            vertices = list(zip(positions[::3], positions[1::3], positions[2::3]))
            faces = list(zip(indices[::3], indices[1::3], indices[2::3]))
            normal_data = None
            if part.get("normals") is not None:
                require(part["normals"] == f"parts/{i}.normals.f32", "project: unexpected normals path")
                normal_data = take(part["normals"], len(positions)*4)
                numeric(normal_data, "f", "project Part normals")
            summary = {"id": part["id"], "name": part["name"], "source_mask_id": part.get("sourceMaskId"), "source_revision": part.get("sourceRevision"), "has_normals": part.get("normals") is not None, **mesh_summary(vertices, faces)}
            parts.append({"metadata": part, "summary": summary, "positions": positions, "indices": indices,
                          "position_data": position_data, "index_data": index_data, "normal_data": normal_data})
        objects = project["masks"] + project["parts"] + project["measurements"] + project.get("centerlines", []) + project.get("polylines", [])
        ids = [obj["id"] for obj in objects]
        require(all(isinstance(value, str) and value for value in ids) and len(ids) == len(set(ids)), "project: duplicate/invalid object IDs")
        for field, collection in (("selectedMaskId", masks), ("selectedPartId", parts)):
            require(not project[field] or any(item["metadata"]["id"] == project[field] for item in collection), f"project: dangling {field}")
        require(set(names) == referenced, "project: unreferenced binary/archive entries")
        report = {"format": metadata["format"], "version": metadata["version"], "entry_count": len(names), "zip_crc_verified": True,
                  "name": project["name"], "selected_mask_id": project["selectedMaskId"], "selected_part_id": project["selectedPartId"],
                  "image": {"name": vm["name"], "dims": dims, "values": value_stats, "header": header},
                  "masks": [m["summary"] for m in masks], "overlapping_voxel_count": sum(v > 1 for v in coverage),
                  "parts": [p["summary"] for p in parts], "measurement_count": len(project["measurements"]),
                  "optional_object_counts": {name: len(project.get(name, [])) for name in ("centerlines", "polylines", "resliceObjects")},
                  "reslice_transform": transform}
        return report, {"metadata": metadata, "header": header, "masks": masks, "parts": parts,
                        "image_values": values, "image_data": image_data, "transform": transform}


def source_object(project, kind):
    objects = project[kind]
    selected = project["metadata"]["project"]["selectedMaskId" if kind == "masks" else "selectedPartId"]
    if selected:
        return next(item for item in objects if item["metadata"]["id"] == selected)
    require(len(objects) == 1, f"comparison: {kind} source is ambiguous; save ZIP with the export source selected")
    return objects[0]


def compare_mask(project, exported):
    source, header = source_object(project, "masks"), exported["header"]
    values = exported["values"]
    mismatch = sum(a != b for a, b in zip(source["data"], values)) + abs(len(source["data"]) - len(values))
    checks = {"dimensions_equal": project["header"]["dims"] == header["dims"],
              "source_byte_order_preserved": project["header"]["endianness"] == header["endianness"],
              "spatial_unit_preserved": project["header"]["spatial_unit_code"] == header["spatial_unit_code"],
              "affine_preserved": matrix_close(project["header"]["affine_native"], header["affine_native"]),
              "uint16_labels": header["datatype"] == 512, "nifti_label_intent": header["intent_code"] == 1002,
              "binary_values": all(v in (0, 1) for v in values), "exact_membership_equal": mismatch == 0}
    return {"ok": all(checks.values()), "source_mask_id": source["metadata"]["id"], "checks": checks,
            "membership_mismatch_count": mismatch, "project_member_count": source["summary"]["member_count"],
            "export_nonzero_count": sum(v != 0 for v in values)}


def compare_stl(project, exported):
    source = source_object(project, "parts")
    part = source["summary"]
    volume_applicable = part["closed_and_consistently_oriented_edges"] and exported["closed_and_consistently_oriented_edges"]
    checks = {"triangle_count_equal": part["triangle_count"] == exported["triangle_count"],
              "triangle_coordinates_equal": part["triangle_fingerprint"] == exported["triangle_fingerprint"],
              "triangle_winding_equal": part["oriented_triangle_fingerprint"] == exported["oriented_triangle_fingerprint"],
              "welded_edge_topology_equal": part["topology_welded_exact"] == exported["topology_welded_exact"],
              "surface_area_equal": close(part["surface_area_mm2"], exported["surface_area_mm2"])}
    if volume_applicable:
        checks["signed_volume_equal"] = close(part["signed_volume_mm3"], exported["signed_volume_mm3"])
    return {"ok": all(checks.values()), "source_part_id": source["metadata"]["id"], "checks": checks,
            "triangle_count": exported["triangle_count"], "surface_area_difference_mm2": exported["surface_area_mm2"] - part["surface_area_mm2"],
            "volume_comparison": {"status": "compared" if volume_applicable else "not_applicable",
                                  "reason": "both surfaces have closed, consistently oriented edge incidence" if volume_applicable else "open, non-manifold, degenerate or inconsistently oriented surface; signed volume depends on its reference point"},
            "signed_volume_difference_mm3": exported["signed_volume_mm3"] - part["signed_volume_mm3"] if volume_applicable else None}


def verify_files(project=None, stl=None, mask=None):
    report = {"ok": True, "verification_scope": "file bytes and quantitative equality; input transport and browser persistence are not established",
              "files": {}, "comparisons": {}, "errors": [], "limitations": [
        "STL has no unit field; project Part coordinates are compared in their millimetre contract.",
        "Exact-coordinate welding does not close small gaps; edge incidence does not prove vertex-manifoldness or absence of self-intersections.",
        "Enclosed volume is the absolute algebraic oriented-surface volume under the closed-surface assumption; complex shells require separate solid validation.",
        "This validates exported synthetic artifacts, not native file-picker interaction, clinical accuracy, or original Mimics equivalence.",
        "Advanced optional objects are counted; their algorithmic semantics are not independently validated."]}
    parsed = {}
    for name, path, parser in (("project", project, inspect_project), ("stl", stl, inspect_stl), ("mask", mask, inspect_nifti)):
        if not path:
            continue
        try:
            summary, parsed[name] = parser(path)
            report["files"][name] = {"path": str(Path(path).resolve()), "sha256": file_sha256(path), **summary}
        except (OSError, ValueError, KeyError, TypeError, StopIteration, struct.error, zipfile.BadZipFile) as error:
            report["errors"].append(f"{name}: {error}")
    if "project" in parsed:
        for name, comparer in (("mask", compare_mask), ("stl", compare_stl)):
            if name not in parsed:
                continue
            try:
                result = comparer(parsed["project"], parsed[name])
                report["comparisons"][f"project_{name}"] = result
                if not result["ok"]:
                    report["errors"].append(f"project_{name}: quantitative comparison failed")
            except (ValueError, KeyError, TypeError, StopIteration) as error:
                report["errors"].append(f"project_{name}: {error}")
    report["ok"] = not report["errors"]
    return report


def compare_identity_projects(source_path, identity_path):
    """All Float32 samples, binary memberships and stored mesh arrays, not UI counts."""
    source_report, source = inspect_project(source_path)
    target_report, target = inspect_project(identity_path)
    require(target["transform"] is not None, "identity comparison: target has no declared reslice transform")
    old_affine, new_affine = source["header"]["affine_mm"], target["header"]["affine_mm"]
    require(old_affine is not None and new_affine is not None, "identity comparison: known millimetre affines are required")
    transform = target["transform"]
    expected_mapping = matrix_product(matrix_product(inverse_affine(old_affine), transform["new_world_mm_to_old_world_mm"]), homogeneous(new_affine))
    residual = matrix_residual(transform["new_ijk_to_old_ijk"], expected_mapping)
    values, new_values = source["image_values"], target["image_values"]
    gray_mismatches = sum(a != b for a, b in zip(values, new_values)) + abs(len(values) - len(new_values))
    source_masks = {item["metadata"]["id"]: item for item in source["masks"]}
    target_masks = {item["metadata"]["id"]: item for item in target["masks"]}
    mask_checks = []
    for identifier in sorted(set(source_masks) | set(target_masks)):
        old, new = source_masks.get(identifier), target_masks.get(identifier)
        if old is None or new is None:
            mask_checks.append({"id": identifier, "ok": False, "error": "Mask missing from one project"})
            continue
        a, b = old["data"], new["data"]
        mismatch = sum(x != y for x, y in zip(a, b)) + abs(len(a) - len(b))
        mask_checks.append({"id": identifier, "ok": mismatch == 0,
                            "membership_mismatch_count": mismatch,
                            "source_member_count": old["summary"]["member_count"],
                            "identity_member_count": new["summary"]["member_count"],
                            "raw_bytes_equal": a == b,
                            "source_revision": old["metadata"]["revision"],
                            "identity_revision": new["metadata"]["revision"],
                            "threshold_metadata_equal": old["metadata"].get("threshold") == new["metadata"].get("threshold")})
    source_parts = {item["metadata"]["id"]: item for item in source["parts"]}
    target_parts = {item["metadata"]["id"]: item for item in target["parts"]}
    part_checks = []
    for identifier in sorted(set(source_parts) | set(target_parts)):
        old, new = source_parts.get(identifier), target_parts.get(identifier)
        if old is None or new is None:
            part_checks.append({"id": identifier, "ok": False, "error": "Part missing from one project"})
            continue
        checks = {"position_float32_values_equal": old["positions"] == new["positions"],
                  "position_bytes_equal": old["position_data"] == new["position_data"],
                  "index_uint32_values_equal": old["indices"] == new["indices"],
                  "index_bytes_equal": old["index_data"] == new["index_data"],
                  "normal_bytes_equal": old["normal_data"] == new["normal_data"],
                  "oriented_faces_equal": old["summary"]["oriented_triangle_fingerprint"] == new["summary"]["oriented_triangle_fingerprint"]}
        part_checks.append({"id": identifier, "ok": all(checks.values()), "checks": checks,
                            "triangle_count": new["summary"]["triangle_count"],
                            "source_revision_preserved": old["metadata"].get("sourceRevision") == new["metadata"].get("sourceRevision")})
    checks = {"dimensions_equal": source["header"]["dims"] == target["header"]["dims"],
              "physical_affine_equal": matrix_close(old_affine, new_affine),
              "update_cs_off": not transform["update_cs"],
              "gray_float32_values_equal": gray_mismatches == 0,
              "gray_float32_bytes_equal": source["image_data"] == target["image_data"],
              "all_independent_mask_bytes_equal": all(item["ok"] for item in mask_checks),
              "all_stored_mesh_arrays_equal": all(item["ok"] for item in part_checks),
              "sampling_matrix_matches_independent_source_and_target_affines": residual <= 1e-8}
    source_description = {"path": str(Path(source_path).resolve()), "sha256": file_sha256(source_path),
                          "dims": source["header"]["dims"], "affine_mm": old_affine}
    target_description = {"path": str(Path(identity_path).resolve()), "sha256": file_sha256(identity_path),
                          "dims": target["header"]["dims"], "affine_mm": new_affine}
    return {"ok": all(checks.values()), "verification_scope": "independently decoded identity reslice: every stored Float32 voxel, every Mask byte and all Part mesh arrays",
            "source": source_description, "identity": target_description, "checks": checks,
            "gray": {"compared_voxel_count": len(values), "value_mismatch_count": gray_mismatches,
                     "source_float32_sha256": hashlib.sha256(source["image_data"]).hexdigest(),
                     "identity_float32_sha256": hashlib.sha256(target["image_data"]).hexdigest()},
            "masks": mask_checks, "parts": part_checks,
            "transform": {**transform, "independently_expected_new_ijk_to_old_ijk": expected_mapping,
                          "source_sampling_map_checked": True, "sampling_matrix_max_abs_residual": residual},
            "source_optional_object_counts": source_report["optional_object_counts"],
            "identity_optional_object_counts": target_report["optional_object_counts"],
            "errors": [name for name, passed in checks.items() if not passed],
            "limitations": ["This is an identity-grid test; it does not establish arbitrary-angle interpolation accuracy or native Mimics equivalence.",
                            "Project headers, names and expected Mask revision changes need not be byte-identical.",
                            "Optional world objects are counted here; their full conversion semantics remain separately tested."]}


def self_test():
    """Literal analytic fixtures, constructed without any application code."""
    cases = []
    vertices = [(0., 0., 0.), (1., 0., 0.), (0., 1., 0.), (0., 0., 1.)]
    faces = [(0, 2, 1), (0, 1, 3), (0, 3, 2), (1, 2, 3)]
    def check(label, condition):
        require(condition, f"self-test failed: {label}")
        cases.append(label)
    def rejects(label, function):
        try:
            function()
        except (VerificationError, zipfile.BadZipFile):
            cases.append(label)
        else:
            raise VerificationError(f"self-test unexpectedly accepted: {label}")
    tetra = mesh_summary(vertices, faces)
    check("analytic tetrahedron bounds, area and volume", tetra["bounds_mm"] == {"min": [0., 0., 0.], "max": [1., 1., 1.]} and close(tetra["surface_area_mm2"], (3 + math.sqrt(3))/2) and close(tetra["enclosed_volume_mm3"], 1/6))
    check("closed tetrahedron has no open or non-manifold edges", tetra["topology_indexed"]["boundary_edges"] == tetra["topology_indexed"]["non_manifold_edges"] == 0)
    check("open triangle has three boundary edges", mesh_summary(vertices[:3], [(0, 1, 2)])["topology_indexed"]["boundary_edges"] == 3)
    nonmanifold = mesh_summary(vertices + [(0., -1., 0.)], [(0, 1, 2), (1, 0, 3), (0, 1, 4)])
    check("three faces sharing an edge are non-manifold", nonmanifold["topology_indexed"]["non_manifold_edges"] == 1)
    rejects("out-of-bounds mesh index rejected", lambda: mesh_summary(vertices, [(0, 1, 99)]))
    def header(endian, unit, datatype, intent=0):
        h = bytearray(352)
        put = lambda code, offset, *values: struct.pack_into(endian + code, h, offset, *values)
        put("i", 0, 348); put("8h", 40, 3, 2, 2, 1, 1, 1, 1, 1)
        put("h", 68, intent); put("h", 70, datatype); put("h", 72, DATATYPES[datatype][1])
        scale = {1: .001, 2: 1., 3: 1000.}[unit]
        put("8f", 76, 1, scale, 2*scale, 3*scale, 0, 0, 0, 0)
        put("f", 108, 352); put("f", 112, 1); h[123] = unit; put("h", 254, 1)
        for r, row in enumerate(((1, 0, 0, 10), (0, 2, 0, -20), (0, 0, 3, 30))):
            put("4f", 280 + 16*r, *(value*scale for value in row))
        h[344:348] = b"n+1\0"
        return h
    # Some managed Windows sessions expose an unwritable system TEMP. Keep fixtures
    # in a new, isolated child of this script's known workspace directory instead.
    fixture_parent = Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory(prefix=".mimics-export-oracle-", dir=fixture_parent) as folder:
        folder = Path(folder)
        require(folder.resolve().parent == fixture_parent, "self-test temporary directory escaped the script workspace")
        project_path, stl_path, mask_path = folder/"known.zip", folder/"known.stl", folder/"known.nii"
        source_header = header(">", 1, 16)
        geometry = [[.001, 0, 0, .01], [0, .002, 0, -.02], [0, 0, .003, .03]]
        metadata = {"format": "deepmark-mimics-workbench", "version": 1, "endianness": "little",
                    "volume": {"name": "synthetic", "dims": [2, 2, 1], "little": False, "affine": geometry, "spacing": [1, 2, 3], "unit": "mm", "oblique": False, "min": 10, "max": 40},
                    "project": {"name": "known", "selectedMaskId": "a", "selectedPartId": "p", "measurements": [],
                                "masks": [{"id": "a", "name": "a", "path": "masks/0.u8", "threshold": [10, 30], "revision": 1, "visible": True, "color": "#112233", "opacity": 0}, {"id": "b", "name": "b", "path": "masks/1.u8", "threshold": None, "revision": 0, "visible": False, "color": "#445566", "opacity": .5}],
                                "parts": [{"id": "p", "name": "tetra", "positions": "parts/0.positions.f32", "indices": "parts/0.indices.u32", "sourceMaskId": "a", "sourceRevision": 1, "visible": True, "color": "#778899", "opacity": 1}]}}
        files = {"project.json": json.dumps(metadata).encode(), "image/header.bin": bytes(source_header[:348]), "image/values.f32": struct.pack("<4f", 10, 20, 30, 40),
                 "masks/0.u8": bytes([1, 0, 1, 0]), "masks/1.u8": bytes([0, 1, 1, 0]),
                 "parts/0.positions.f32": struct.pack("<12f", *(v for point in vertices for v in point)), "parts/0.indices.u32": struct.pack("<12I", *(v for face in faces for v in face))}
        def write_zip(destination, entries):
            with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as archive:
                for name, data in entries.items():
                    archive.writestr(name, data)
        write_zip(project_path, files)
        normals = [(0, 0, -1), (0, -1, 0), (-1, 0, 0), (1/math.sqrt(3),)*3]
        stl_bytes = bytearray(b"analytic tetrahedron".ljust(80, b"\0") + struct.pack("<I", 4))
        for normal, face in zip(normals, faces):
            stl_bytes.extend(struct.pack("<12fH", *normal, *(v for i in face for v in vertices[i]), 0))
        stl_path.write_bytes(stl_bytes)
        mask_path.write_bytes(header(">", 1, 512, 1002) + struct.pack(">4H", 1, 0, 1, 0))
        result = verify_files(project_path, stl_path, mask_path)
        check("hand-built ZIP, big-endian metre NIfTI and STL compare exactly", result["ok"])
        check("independent masks retain two members and one overlapping voxel", [m["member_count"] for m in result["files"]["project"]["masks"]] == [2, 2] and result["files"]["project"]["overlapping_voxel_count"] == 1)
        check("metre affine yields 12 cubic mm mask volume within float32 rounding", close(result["files"]["project"]["masks"][0]["member_volume_mm3"], 12, 1e-5))
        open_vertices = [(0., 0., 5.), (0., 0., 1.), (1., 0., 1.), (0., 1., 1.)]
        open_files = {**files, "parts/0.positions.f32": struct.pack("<12f", *(v for point in open_vertices for v in point)), "parts/0.indices.u32": struct.pack("<3I", 1, 2, 3)}
        write_zip(folder/"open.zip", open_files)
        open_stl = b"open triangle, source vertex zero unused".ljust(80, b"\0") + struct.pack("<I", 1) + struct.pack("<12fH", 0, 0, 1, *(v for point in open_vertices[1:] for v in point), 0)
        (folder/"open.stl").write_bytes(open_stl)
        open_result = verify_files(folder/"open.zip", folder/"open.stl")
        check("same open triangle with unused vertex zero compares without signed-volume assumptions", open_result["ok"] and open_result["comparisons"]["project_stl"]["volume_comparison"]["status"] == "not_applicable" and open_result["comparisons"]["project_stl"]["signed_volume_difference_mm3"] is None)
        for endian in ("<", ">"):
            for unit in (1, 2, 3):
                mask_path.write_bytes(header(endian, unit, 512, 1002) + struct.pack(endian+"4H", 1, 0, 1, 0))
                summary, _ = inspect_nifti(mask_path)
                check(f"NIfTI unit {unit} byte-order {endian} independently decoded", close(summary["affine_mm"][0][3], 10) and close(summary["affine_mm"][1][1], 2) and summary["scaled_statistics"]["nonzero_count"] == 2)
        scaled_header = header(">", 2, 4)
        struct.pack_into(">2f", scaled_header, 112, 2, -1000)
        mask_path.write_bytes(scaled_header + struct.pack(">4h", -2, 0, 1, 3))
        summary, _ = inspect_nifti(mask_path)
        check("signed big-endian voxels and intensity scaling are independent", summary["scaled_statistics"] == {"count": 4, "min": -1004., "max": -994., "mean": -999., "nonzero_count": 4})
        q_header = header("<", 3, 512)
        struct.pack_into("<h", q_header, 254, 0); struct.pack_into("<h", q_header, 252, 1)
        struct.pack_into("<f", q_header, 76, -1)
        struct.pack_into("<3f", q_header, 256, 0, 0, math.sqrt(.5)); struct.pack_into("<3f", q_header, 268, 5, 6, 7)
        mask_path.write_bytes(q_header + struct.pack("<4H", 1, 0, 1, 0))
        summary, _ = inspect_nifti(mask_path)
        check("qform quaternion, reflection and micron units are independent", summary["affine_method"] == "qform" and matrix_close(summary["affine_mm"], [[0, -2, 0, .005], [1, 0, 0, .006], [0, 0, -3, .007]]))
        mask_path.write_bytes(header(">", 1, 512, 1002) + struct.pack(">4H", 0, 1, 1, 0))
        check("same-count wrong membership fails quantitative comparison", not verify_files(project_path, mask=mask_path)["ok"])
        damaged = {**files, "masks/0.u8": bytes([1, 0, 2, 0])}; write_zip(folder/"bad-mask.zip", damaged)
        rejects("non-binary project Mask rejected", lambda: inspect_project(folder/"bad-mask.zip"))
        damaged = {**files, "masks/0.u8": bytes([1, 0, 1])}; write_zip(folder/"short.zip", damaged)
        rejects("wrong referenced buffer length rejected", lambda: inspect_project(folder/"short.zip"))
        damaged = {**files, "parts/0.indices.u32": struct.pack("<12I", 99, *tuple(v for face in faces for v in face)[1:])}; write_zip(folder/"bad-index.zip", damaged)
        rejects("project index buffer bounds checked", lambda: inspect_project(folder/"bad-index.zip"))
        stl_path.write_bytes(stl_bytes[:-1]); rejects("truncated binary STL rejected", lambda: inspect_stl(stl_path))
        flipped = bytearray(stl_bytes); flipped[96:108], flipped[108:120] = flipped[108:120], flipped[96:108]
        stl_path.write_bytes(flipped)
        check("changed STL face winding fails source comparison", not verify_files(project_path, stl=stl_path)["ok"])
        mask_path.write_bytes(header("<", 2, 512, 1002) + struct.pack("<3H", 1, 0, 1)); rejects("truncated NIfTI data rejected", lambda: inspect_nifti(mask_path))
        bad_header = header("<", 2, 512); struct.pack_into("<h", bad_header, 72, 32)
        mask_path.write_bytes(bad_header + struct.pack("<4H", 1, 0, 1, 0)); rejects("NIfTI datatype/bitpix conflict rejected", lambda: inspect_nifti(mask_path))
        mask_path.write_bytes(header("<", 2, 16) + struct.pack("<4f", 1, math.nan, 0, 0)); rejects("non-finite NIfTI value rejected", lambda: inspect_nifti(mask_path))
        crc_bad = bytearray(project_path.read_bytes())
        with zipfile.ZipFile(project_path) as archive:
            entry = archive.getinfo("masks/0.u8")
            name_length, extra_length = struct.unpack_from("<HH", crc_bad, entry.header_offset + 26)
            crc_bad[entry.header_offset + 30 + name_length + extra_length] ^= 1
        (folder/"crc.zip").write_bytes(crc_bad); rejects("ZIP CRC corruption rejected", lambda: inspect_project(folder/"crc.zip"))
        # Literal optional-transform fixtures: not exported by the application.
        identity_rows = "1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n"
        literal_transform = ("Deepmark Reslice Project coordinate transforms (independent application format; not a vendor TXT format).\n"
                             "Update CS: off.\n"
                             "Coordinates use millimetres. Homogeneous column vectors; matrices printed row-major.\n"
                             "Voxel IJK coordinates refer to sample centers.\n\n"
                             + "\n".join(heading + "\n" + identity_rows for heading in TRANSFORM_HEADINGS))
        def with_transform(text=literal_transform):
            changed_metadata = json.loads(json.dumps(metadata))
            changed_metadata["project"]["resliceTransform"] = text
            return {**files, "project.json": json.dumps(changed_metadata).encode(),
                    "reslice-transform.txt": text.encode("utf-8") if isinstance(text, str) else b"invalid"}
        transformed_path = folder/"transform.zip"
        transform_files = with_transform()
        write_zip(transformed_path, transform_files)
        summary, parsed_transform = inspect_project(transformed_path)
        check("literal declared reslice-transform.txt is exactly referenced and parsed", summary["reslice_transform"]["update_cs"] is False and parsed_transform["transform"]["new_ijk_to_old_ijk"] == homogeneous([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]))
        check("literal identity transform map agrees with independently parsed source affine", compare_identity_projects(project_path, transformed_path)["ok"])
        write_zip(folder/"missing-transform.zip", {k: v for k, v in transform_files.items() if k != "reslice-transform.txt"})
        rejects("declared transform without its fixed text entry rejected", lambda: inspect_project(folder/"missing-transform.zip"))
        write_zip(folder/"mismatched-transform.zip", {**transform_files, "reslice-transform.txt": literal_transform.replace("Update CS: off.", "Update CS: on.").encode()})
        rejects("fixed transform text different from metadata rejected byte for byte", lambda: inspect_project(folder/"mismatched-transform.zip"))
        write_zip(folder/"undeclared-transform.zip", {**files, "reslice-transform.txt": literal_transform.encode()})
        rejects("undeclared fixed transform entry remains an unreferenced entry", lambda: inspect_project(folder/"undeclared-transform.zip"))
        write_zip(folder/"unexpected-transform-entry.zip", {**transform_files, "other-transform.txt": literal_transform.encode()})
        rejects("declared transform does not allow another arbitrary archive entry", lambda: inspect_project(folder/"unexpected-transform-entry.zip"))
        for label, text in (("empty", ""), ("null", None), ("nonstring", 42), ("oversized UTF-8", "汉" * 23000)):
            write_zip(folder/"bad-transform-field.zip", with_transform(text))
            rejects(f"{label} resliceTransform metadata rejected", lambda: inspect_project(folder/"bad-transform-field.zip"))
        wrong_inverse = literal_transform.replace(TRANSFORM_HEADINGS[1] + "\n1 0 0 0", TRANSFORM_HEADINGS[1] + "\n1 0 0 5")
        write_zip(folder/"bad-transform-inverse.zip", with_transform(wrong_inverse))
        rejects("declared but noninverse transform matrices rejected", lambda: inspect_project(folder/"bad-transform-inverse.zip"))
        wrong_map = literal_transform.replace(TRANSFORM_HEADINGS[2] + "\n1 0 0 0", TRANSFORM_HEADINGS[2] + "\n1 0 0 1")
        write_zip(folder/"bad-transform-map.zip", with_transform(wrong_map))
        check("wrong sampling map fails source-affine comparison even when bytes and counts match", not compare_identity_projects(project_path, folder/"bad-transform-map.zip")["ok"])
        wrong_rows = literal_transform.replace(TRANSFORM_HEADINGS[0] + "\n1 0 0 0", TRANSFORM_HEADINGS[0] + "\n1 0 0")
        write_zip(folder/"bad-transform-shape.zip", with_transform(wrong_rows))
        rejects("a matching declared transform still requires complete 4x4 matrix rows", lambda: inspect_project(folder/"bad-transform-shape.zip"))
        wrong_finite = literal_transform.replace(TRANSFORM_HEADINGS[0] + "\n1 0 0 0", TRANSFORM_HEADINGS[0] + "\n1 0 0 NaN")
        write_zip(folder/"nonfinite-transform.zip", with_transform(wrong_finite))
        rejects("a matching declared transform still rejects nonfinite matrix values", lambda: inspect_project(folder/"nonfinite-transform.zip"))
    return {"ok": True, "self_test": {"passed": len(cases), "cases": cases}, "errors": []}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", help="Deepmark workbench v1 ZIP")
    parser.add_argument("--source-project", help="independent source ZIP for an exact identity-reslice comparison with --project")
    parser.add_argument("--stl", help="binary STL exported from the ZIP-selected Part")
    parser.add_argument("--mask", help="NIfTI exported from the ZIP-selected Mask (.nii or .nii.gz)")
    parser.add_argument("--output-json", help="write detailed machine-readable report")
    parser.add_argument("--self-test", action="store_true", help="verify the oracle against literal analytic fixtures")
    args = parser.parse_args()
    if not args.self_test and not any((args.project, args.stl, args.mask)):
        parser.error("provide --project, --stl, --mask, or --self-test")
    if args.source_project and (not args.project or args.self_test or args.stl or args.mask):
        parser.error("--source-project requires --project and cannot combine with --self-test/--stl/--mask")
    try:
        report = self_test() if args.self_test else compare_identity_projects(args.source_project, args.project) if args.source_project else verify_files(args.project, args.stl, args.mask)
    except (VerificationError, OSError, ValueError, KeyError, TypeError, struct.error, zipfile.BadZipFile) as error:
        report = {"ok": False, "errors": [str(error)]}
    if args.output_json:
        output = Path(args.output_json)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        print(json.dumps({"ok": report["ok"], "output_json": str(output.resolve()), "errors": report.get("errors", []), "self_test_passed": report.get("self_test", {}).get("passed")}, ensure_ascii=False))
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
