#!/usr/bin/env python3
"""Independent standard-library oracle for the recorded synthetic oblique browser reslice.

This deliberately verifies one known analytic case, not arbitrary UI parameters.
No application TypeScript, JavaScript, parser, sampler or object converter is run.
The sibling Python format verifier supplies independent byte-format inspection.
"""
import argparse
import importlib.util
import json
import math
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location("independent_export_oracle", Path(__file__).with_name("verify-mimics-browser-exports.py"))
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
require = oracle.require

SOURCE_DIMS = [96, 96, 64]
SOURCE_AFFINE = [[1., 0., 0., 0.], [0., 1., 0., 0.], [0., 0., 1.5, 0.]]
OUTPUT_DIMS = [48, 48, 64]
OUTPUT_AFFINE = [[2., 0., 0., 0.], [0., 2., 0., 0.], [0., 0., 1.5, 0.]]
START = [0., 47.5, 47.25]
END = [95., 47.5, 47.25]
U = [0., .5, -math.sqrt(3)/2]
V = [0., math.sqrt(3)/2, .5]
N = [1., 0., 0.]
S = [START[k] - 47*(U[k]+V[k]) for k in range(3)]
BACKGROUND = -1000.


def dot(a, b):
    return math.fsum(x*y for x, y in zip(a, b))


def f32(value):
    return struct.unpack("<f", struct.pack("<f", value))[0]


def f32_tolerance(value):
    # Two Float32 ULPs, with a 1e-5 floor near zero; never a percent tolerance.
    exponent = math.frexp(abs(value))[1] if value else -148
    return max(1e-5, 2*2.**max(-149, exponent-24))


def nearest_half_up(value):
    lower = math.floor(value)
    half = lower + .5
    if abs(value-half) <= 2*math.ulp(abs(half)):
        return lower+1
    return math.floor(value+.5)


def world_from_output(x, y, z):
    # Derived solely from the recorded start/up/30-degree rotation and spacing.
    return [S[k] + 2*x*U[k] + 2*y*V[k] + 1.5*z*N[k] for k in range(3)]


def new_world(point, as_vector=False):
    delta = point if as_vector else [point[k]-S[k] for k in range(3)]
    return [dot(axis, delta) for axis in (U, V, N)]


def sample_linear(values, dims, q):
    if any(q[k] < -1e-7 or q[k] > dims[k]-1+1e-7 for k in range(3)):
        return BACKGROUND, False
    q = [min(dims[k]-1, max(0., q[k])) for k in range(3)]
    low = [math.floor(value) for value in q]
    high = [min(dims[k]-1, low[k]+1) for k in range(3)]
    fraction = [q[k]-low[k] for k in range(3)]
    terms = []
    for iz in (0, 1):
        for iy in (0, 1):
            for ix in (0, 1):
                flags = [ix, iy, iz]
                weight = math.prod(fraction[k] if flags[k] else 1-fraction[k] for k in range(3))
                if weight:
                    p = [high[k] if flags[k] else low[k] for k in range(3)]
                    terms.append(weight*values[p[0]+dims[0]*(p[1]+dims[1]*p[2])])
    return f32(math.fsum(terms)), True


def nearest_source_index(dims, q):
    if any(q[k] < -.5 or q[k] > dims[k]-.5 for k in range(3)):
        return None
    p = [min(dims[k]-1, max(0, nearest_half_up(q[k]))) for k in range(3)]
    return p[0]+dims[0]*(p[1]+dims[1]*p[2])


def compare_array(actual, expected, quantized=False):
    maximum, mismatch, exact = 0., abs(len(actual)-len(expected)), 0
    for a, b in zip(actual, expected):
        if quantized:
            b = f32(b)
        error = abs(a-b)
        maximum = max(maximum, error)
        exact += a != b
        mismatch += error > f32_tolerance(b) if quantized else error > 1e-8
    return {"ok": mismatch == 0, "value_count": len(expected), "mismatch_count": mismatch,
            "exact_value_mismatch_count": exact, "max_absolute_error": maximum,
            "tolerance": "max(1e-5, 2 Float32 ULP)" if quantized else "absolute 1e-8"}


def verify(source_path, output_path):
    source_report, source = oracle.inspect_project(source_path)
    target_report, target = oracle.inspect_project(output_path)
    require(source["header"]["dims"] == SOURCE_DIMS and oracle.matrix_close(source["header"]["affine_mm"], SOURCE_AFFINE),
            "analytic case: source is not the recorded 96x96x64 1/1/1.5mm synthetic grid")
    require(target["header"]["dims"] == OUTPUT_DIMS and oracle.matrix_close(target["header"]["affine_mm"], OUTPUT_AFFINE),
            "analytic case: output is not the recorded 48x48x64 Update-CS local grid")
    transform = target["transform"]
    require(transform and transform["update_cs"], "analytic case: expected a declared Update-CS-on transform")
    require(target["header"]["datatype"] == 16 and target["header"]["slope"] == 1 and target["header"]["intercept"] == 0,
            "analytic case: expected canonical quantitative Float32 output")
    analytic_t = [axis + [-dot(axis, S)] for axis in (U, V, N)] + [[0., 0., 0., 1.]]
    analytic_inverse = [[U[k], V[k], N[k], S[k]] for k in range(3)] + [[0., 0., 0., 1.]]
    analytic_sampling = oracle.matrix_product(oracle.matrix_product(oracle.inverse_affine(SOURCE_AFFINE), analytic_inverse), oracle.homogeneous(OUTPUT_AFFINE))
    residuals = {"old_world_to_new_world": oracle.matrix_residual(transform["old_world_mm_to_new_world_mm"], analytic_t),
                 "new_world_to_old_world": oracle.matrix_residual(transform["new_world_mm_to_old_world_mm"], analytic_inverse),
                 "new_ijk_to_old_ijk": oracle.matrix_residual(transform["new_ijk_to_old_ijk"], analytic_sampling)}
    source_masks = {item["metadata"]["id"]: item for item in source["masks"]}
    target_masks = {item["metadata"]["id"]: item for item in target["masks"]}
    require(source_masks.keys() == target_masks.keys(), "analytic case: source and target Mask IDs differ")
    mask_mismatch = {identifier: 0 for identifier in source_masks}
    expected_members = {identifier: 0 for identifier in source_masks}
    gray_outside = mask_outside = gray_mismatch = exact_gray_mismatch = 0
    max_gray_error, gray_error_sum = 0., 0.
    for z in range(64):
        for y in range(48):
            for x in range(48):
                index = x + 48*(y+48*z)
                world = world_from_output(x, y, z)
                q = [world[0], world[1], world[2]/1.5]
                expected, valid = sample_linear(source["image_values"], SOURCE_DIMS, q)
                gray_outside += not valid
                actual = target["image_values"][index]
                error = abs(actual-expected)
                max_gray_error = max(max_gray_error, error)
                gray_error_sum += error
                exact_gray_mismatch += actual != expected
                gray_mismatch += error > f32_tolerance(expected)
                source_index = nearest_source_index(SOURCE_DIMS, q)
                mask_outside += source_index is None
                for identifier, item in source_masks.items():
                    member = item["data"][source_index] if source_index is not None else 0
                    expected_members[identifier] += member
                    mask_mismatch[identifier] += target_masks[identifier]["data"][index] != member
    mask_checks = []
    for identifier, item in source_masks.items():
        target_mask = target_masks[identifier]
        checks = {"every_membership_matches_nearest_oracle": mask_mismatch[identifier] == 0,
                  "revision_incremented_once": target_mask["metadata"]["revision"] == item["metadata"]["revision"]+1,
                  "threshold_metadata_preserved": target_mask["metadata"]["threshold"] == item["metadata"]["threshold"]}
        mask_checks.append({"id": identifier, "ok": all(checks.values()), "checks": checks,
                            "membership_mismatch_count": mask_mismatch[identifier],
                            "source_member_count": item["summary"]["member_count"],
                            "expected_output_member_count": expected_members[identifier],
                            "actual_output_member_count": target_mask["summary"]["member_count"],
                            "source_revision": item["metadata"]["revision"], "output_revision": target_mask["metadata"]["revision"]})
    source_parts = {item["metadata"]["id"]: item for item in source["parts"]}
    target_parts = {item["metadata"]["id"]: item for item in target["parts"]}
    require(source_parts.keys() == target_parts.keys(), "analytic case: source and target Part IDs differ")
    part_checks = []
    for identifier, old in source_parts.items():
        new = target_parts[identifier]
        expected_positions = [v for i in range(0, len(old["positions"]), 3) for v in new_world(old["positions"][i:i+3])]
        positions = compare_array(new["positions"], expected_positions, True)
        old_normals = oracle.numeric(old["normal_data"], "f", "source normals") if old["normal_data"] is not None else None
        new_normals = oracle.numeric(new["normal_data"], "f", "output normals") if new["normal_data"] is not None else None
        normals = compare_array(new_normals, [v for i in range(0, len(old_normals), 3) for v in new_world(old_normals[i:i+3], True)], True) if old_normals is not None and new_normals is not None else {"ok": old_normals is None and new_normals is None}
        source_revision = old["metadata"].get("sourceRevision")
        source_id = old["metadata"].get("sourceMaskId")
        reference_preserved = new["metadata"].get("sourceRevision") == source_revision and new["metadata"].get("sourceMaskId") == source_id
        source_mask = target_masks.get(source_id)
        stale = source_mask is not None and source_revision is not None and source_revision < source_mask["metadata"]["revision"]
        checks = {"positions_follow_T": positions["ok"], "normals_follow_R_only": normals["ok"],
                  "index_bytes_unchanged": old["index_data"] == new["index_data"],
                  "source_reference_preserved": reference_preserved, "retained_geometry_is_stale": stale}
        part_checks.append({"id": identifier, "ok": all(checks.values()), "checks": checks,
                            "positions": positions, "normals": normals,
                            "triangle_count": new["summary"]["triangle_count"],
                            "source_revision": source_revision,
                            "resampled_mask_revision": source_mask["metadata"]["revision"] if source_mask else None})
    source_rps = {item["id"]: item for item in source["metadata"]["project"].get("resliceObjects", [])}
    target_rps = {item["id"]: item for item in target["metadata"]["project"].get("resliceObjects", [])}
    require(source_rps.keys() == target_rps.keys(), "analytic case: source and output RP IDs differ")
    rp_checks = []
    for identifier, old in source_rps.items():
        new = target_rps[identifier]
        components = {field: compare_array(new["plane"][field], new_world(old["plane"][field], field != "origin")) for field in ("origin", "u", "v")}
        checks = {"origin_and_steps_follow_T_R": all(item["ok"] for item in components.values()),
                  "output_sample_counts_preserved": old["plane"]["size"] == new["plane"]["size"]}
        rp_checks.append({"id": identifier, "ok": all(checks.values()), "checks": checks, "components": components})
    checks = {"analytic_transform_matrices_match": all(value <= 1e-8 for value in residuals.values()),
              "all_gray_values_match_linear_Float32_oracle": gray_mismatch == 0,
              "recorded_outside_gray_count_matches": gray_outside == 24448,
              "all_independent_masks_match_nearest_oracle": all(item["ok"] for item in mask_checks),
              "all_retained_parts_follow_coordinate_change": all(item["ok"] for item in part_checks),
              "all_retained_RPs_follow_coordinate_change": all(item["ok"] for item in rp_checks)}
    return {"ok": all(checks.values()),
            "verification_scope": "recorded 30-degree CS-on synthetic reslice; every gray voxel/Mask membership plus retained Part/RP coordinates, independently parsed in Python",
            "files": {"source": {"path": str(Path(source_path).resolve()), "sha256": oracle.file_sha256(source_path)},
                      "resliced": {"path": str(Path(output_path).resolve()), "sha256": oracle.file_sha256(output_path)}},
            "analytic_case": {"source_dims": SOURCE_DIMS, "source_affine_mm": SOURCE_AFFINE,
                              "output_dims": OUTPUT_DIMS, "output_affine_mm": OUTPUT_AFFINE,
                              "start_mm": START, "end_mm": END, "up_mm": [0, 1, 0], "rotation_degrees": 30,
                              "width_height_mm": [96, 96], "pixel_size_mm": 2, "slice_distance_mm": 1.5,
                              "u": U, "v": V, "normal": N, "first_stored_sample_source_world_mm": S,
                              "sampled_line_length_mm": 94.5, "remaining_line_length_mm": .5,
                              "background_gray": BACKGROUND, "update_cs": True},
            "checks": checks, "transform_matrix_max_abs_residuals": residuals,
            "expected_old_world_to_new_world": analytic_t, "expected_new_world_to_old_world": analytic_inverse,
            "expected_new_ijk_to_old_ijk": analytic_sampling,
            "gray": {"compared_voxel_count": math.prod(OUTPUT_DIMS), "mismatch_count": gray_mismatch,
                     "exact_Float32_value_mismatch_count": exact_gray_mismatch, "max_absolute_error": max_gray_error,
                     "mean_absolute_error": gray_error_sum/math.prod(OUTPUT_DIMS),
                     "tolerance": "max(1e-5, 2 Float32 ULP)", "expected_outside_count": gray_outside,
                     "expected_valid_count": math.prod(OUTPUT_DIMS)-gray_outside},
            "nearest_policy": "closed source half-cell support; within two Float64 ULP of n+0.5 chooses n+1, otherwise floor(x+0.5); clipped at source edge",
            "expected_outside_mask_support_count": mask_outside,
            "masks": mask_checks, "parts": part_checks, "reslice_objects": rp_checks,
            "errors": [name for name, passed in checks.items() if not passed],
            "limitations": ["This checks one recorded synthetic browser export and does not establish all-angle, all-file or native Mimics equivalence.",
                            "The two-Float32-ULP allowance covers independently ordered floating arithmetic; Mask and mesh-index comparisons are exact.",
                            "The source and downloaded resliced files are read only; transport and browser actions require their separate UI evidence."]}


def self_test():
    cases = []
    def check(label, condition):
        require(condition, "self-test: " + label)
        cases.append(label)
    check("recorded axes form an orthonormal right-handed frame", oracle.close(dot(U, V), 0) and oracle.close(dot(U, U), 1) and oracle.close(dot(V, V), 1) and oracle.close(oracle.determinant([U, V, N]), 1))
    check("output grid middle of first slice recovers recorded line start", all(oracle.close(a, b) for a, b in zip(world_from_output(23.5, 23.5, 0), START)))
    check("sampled final stack center stops at 94.5 rather than extending to 95", all(oracle.close(a, b) for a, b in zip(world_from_output(23.5, 23.5, 63), [94.5, 47.5, 47.25])))
    value, valid = sample_linear([0., 1., 10., 11., 100., 101., 110., 111.], [2, 2, 2], [.25, .5, .75])
    check("trilinear raw interpolation reproduces an independent affine scalar field", valid and value == 80.25)
    check("outside source centers use the explicit finite background", sample_linear([1.], [1, 1, 1], [.5, 0, 0]) == (BACKGROUND, False))
    check("positive and negative half coordinates choose the upper cell", nearest_half_up(.5) == 1 and nearest_half_up(-.5) == 0)
    check("two ULP half tie repair is narrow rather than a blanket epsilon", nearest_half_up(.5-2*math.ulp(.5)) == 1 and nearest_half_up(.5-3*math.ulp(.5)) == 0)
    check("normal transformation excludes point translation", all(oracle.close(a, b) for a, b in zip(new_world([1, 0, 0], True), [0, 0, 1])) and new_world([1, 0, 0]) != [0, 0, 1])
    return {"ok": True, "self_test": {"passed": len(cases), "cases": cases}, "errors": []}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-project")
    parser.add_argument("--resliced-project")
    parser.add_argument("--output-json")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if not args.self_test and not (args.source_project and args.resliced_project):
        parser.error("provide both --source-project and --resliced-project, or --self-test")
    try:
        report = self_test() if args.self_test else verify(args.source_project, args.resliced_project)
    except (ValueError, OSError, TypeError, KeyError, struct.error) as error:
        report = {"ok": False, "errors": [str(error)]}
    if args.output_json:
        path = Path(args.output_json)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False)+"\n", encoding="utf-8")
        print(json.dumps({"ok": report["ok"], "output_json": str(path.resolve()), "errors": report.get("errors", []),
                          "self_test_passed": report.get("self_test", {}).get("passed")}, ensure_ascii=False))
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
