"""Holocube Voxelizer: triangle mesh -> point list (model_data.h) for the 8-layer volumetric display.

Coordinates in the output header:
    x = column on a panel (0..127)
    y = display / depth layer (0..7)
    z = pixel row on a panel (0..127, row 0 is the TOP of the panel)

How it works:
  1. Axes are remapped (--axes) so display x / depth / row come from the model axes you choose.
  2. The model is scaled UNIFORMLY (no stretching) and centred so it fits the real display volume:
     127 px wide, 127 px tall, and 7 layer gaps deep (LAYER_PITCH_PX pixels per gap).
  3. trimesh cuts the mesh exactly at each of the 8 layer planes (trimesh.intersections.mesh_plane).
     The cut gives line segments, which are drawn as a continuous outline (default) or
     scan-filled into a solid cross-section (--solid).

Needs numpy and trimesh (pip install numpy trimesh). trimesh loads the file and does the slicing.
"""

import argparse
from pathlib import Path
import numpy as np
import trimesh

# Grid size
GRID_SIZE_X = 128       # columns per panel
GRID_SIZE_Y = 8         # displays (depth layers)
GRID_SIZE_Z = 128       # pixel rows per panel

# Distance between neighbouring displays in pixel units: 2.5 mm layer pitch / 0.1573 mm pixel pitch ~ 15.9
LAYER_PITCH_PX = 16

EPS = 1e-3              # px; keeps the outer layer planes just inside the model's end faces
FLASH_WARN_BYTES = 300_000


def parse_axes(spec: str):
    """'x,y,z' -> (permutation, signs). Entry n says which model axis feeds display x / depth / row.
    A leading '-' flips that axis, e.g. 'x,y,-z' for a Z-up model (row 0 is the top of the panel)."""
    tokens = spec.replace(" ", "").lower().split(",")
    if len(tokens) != 3:
        raise ValueError("--axes needs three comma-separated entries, e.g. x,y,z")
    perm, sign = [], []
    for t in tokens:
        s = -1.0 if t.startswith("-") else 1.0
        a = t.lstrip("+-")
        if a not in ("x", "y", "z"):
            raise ValueError(f"bad axis '{t}' in --axes (use x, y, z, optionally with a leading '-')")
        perm.append("xyz".index(a))
        sign.append(s)
    if len(set(perm)) != 3:
        raise ValueError("--axes must use each of x, y, z exactly once")
    return perm, np.array(sign)


def load_mesh(model_path: Path) -> trimesh.Trimesh:
    """Load a mesh file with trimesh (scenes are merged into one mesh)."""
    print(f"Loading model: {model_path}")
    mesh = trimesh.load(model_path, force="mesh")
    print(f"Load successful: {len(mesh.faces)} triangles, bounding box extents {mesh.extents}")
    return mesh


def fit_to_grid(mesh: trimesh.Trimesh, perm, sign):
    """Remap axes, then scale uniformly and centre the mesh inside the display volume.
    Returns (fitted trimesh, scale, size in px along display x / depth / row)."""
    v = np.asarray(mesh.vertices, dtype=float)[:, perm] * sign
    lo, hi = v.min(axis=0), v.max(axis=0)
    ext = hi - lo

    limits = np.array([GRID_SIZE_X - 1, (GRID_SIZE_Y - 1) * LAYER_PITCH_PX, GRID_SIZE_Z - 1], dtype=float)
    with np.errstate(divide="ignore"):
        ratios = np.where(ext > 1e-9, limits / ext, np.inf)
    scale = ratios.min()  # the tightest axis decides; the same scale is used on all three
    if not np.isfinite(scale):
        raise ValueError("model has no extent (all points identical)")

    v = (v - (lo + hi) / 2) * scale + limits / 2
    fitted = trimesh.Trimesh(vertices=v, faces=mesh.faces, process=False)  # flips only change winding
    return fitted, scale, ext * scale


def slice_layer(mesh: trimesh.Trimesh, c: float) -> np.ndarray:
    """Cut the mesh with the plane depth == c using trimesh. Returns segments (S, 4) = x0, z0, x1, z1."""
    lines = trimesh.intersections.mesh_plane(mesh, plane_normal=[0.0, 1.0, 0.0], plane_origin=[0.0, c, 0.0])
    if len(lines) == 0:
        return np.zeros((0, 4))
    return np.hstack([lines[:, 0, [0, 2]], lines[:, 1, [0, 2]]])


def raster_outline(seg: np.ndarray, img: np.ndarray):
    """Draw segments into img[z, x]; sampled at <= 0.5 px spacing so lines have no gaps."""
    if len(seg) == 0:
        return
    x0, z0, x1, z1 = seg.T
    n = np.maximum(np.ceil(np.hypot(x1 - x0, z1 - z0) * 2).astype(int), 1) + 1   # samples per segment
    idx = np.repeat(np.arange(len(seg)), n)
    start = np.repeat(np.cumsum(n) - n, n)
    t = (np.arange(n.sum()) - start) / np.repeat(n - 1, n)
    xi = np.rint(x0[idx] + t * (x1 - x0)[idx]).astype(int)
    zi = np.rint(z0[idx] + t * (z1 - z0)[idx]).astype(int)
    ok = (xi >= 0) & (xi < GRID_SIZE_X) & (zi >= 0) & (zi < GRID_SIZE_Z)
    img[zi[ok], xi[ok]] = True


def raster_fill(seg: np.ndarray, img: np.ndarray) -> int:
    """Even-odd scanline fill of the cross-section. Returns how many rows had an odd crossing count
    (which means the mesh isn't closed there; those rows are left as outline only)."""
    if len(seg) == 0:
        return 0
    x0, z0, x1, z1 = seg.T
    bad_rows = 0
    for r in range(GRID_SIZE_Z):
        crosses = (z0 <= r) != (z1 <= r)
        if not crosses.any():
            continue
        xs = x0[crosses] + (r - z0[crosses]) * (x1[crosses] - x0[crosses]) / (z1[crosses] - z0[crosses])
        xs.sort()
        if len(xs) % 2:
            bad_rows += 1
            continue
        for a, b in zip(xs[0::2], xs[1::2]):
            lo, hi = int(np.ceil(a)), int(np.floor(b))
            img[r, max(lo, 0):min(hi, GRID_SIZE_X - 1) + 1] = True
    return bad_rows


def voxelize(mesh: trimesh.Trimesh, solid: bool) -> np.ndarray:
    """Cut the fitted mesh at each of the display's layer planes and collect the lit pixels as (x, y, z) rows."""
    d_min, d_max = mesh.vertices[:, 1].min(), mesh.vertices[:, 1].max()
    layers, bad_total = [], 0
    for k in range(GRID_SIZE_Y):
        c = k * LAYER_PITCH_PX
        if c < d_min - 0.01 or c > d_max + 0.01:
            continue                                # this layer is outside the model
        c = float(np.clip(c, d_min + EPS, d_max - EPS))   # end layers slice just inside the end faces
        seg = slice_layer(mesh, c)
        img = np.zeros((GRID_SIZE_Z, GRID_SIZE_X), dtype=bool)
        raster_outline(seg, img)
        if solid:
            bad_total += raster_fill(seg, img)
        zs, xs = np.nonzero(img)
        layers.append(np.column_stack([xs, np.full_like(xs, k), zs]))

    if not layers or sum(len(p) for p in layers) == 0:
        raise ValueError("no layer plane intersects the model - it is thinner than one layer gap along the "
                         "depth axis. Try --axes to pick a different depth axis.")
    if bad_total:
        print(f"Warning: {bad_total} scanline(s) had an odd number of crossings (mesh not closed); "
              f"those were drawn as outline only.")

    grid = np.vstack(layers)
    grid = grid[np.lexsort((grid[:, 2], grid[:, 1], grid[:, 0]))]   # sort by x, then y, then z
    assert grid.min() >= 0 and grid[:, 0].max() < GRID_SIZE_X and grid[:, 1].max() < GRID_SIZE_Y \
        and grid[:, 2].max() < GRID_SIZE_Z, "point outside grid"    # all fit in uint8 (max value 127)
    return grid.astype(np.uint8)


def generate_header(grid: np.ndarray, model_path: Path, output_path: Path):
    print(f"Output path: {output_path.resolve()}")

    # Format points into C++ array format ({{ braces are escape braces): {{x1,y1,z1},{x2,y2,z2}, ... }}
    points_formatted = ",\n".join(f"    {{{pt[0]}, {pt[1]}, {pt[2]}}}" for pt in grid)

    header_code = f"""// .h Header File with 128x8x128 Voxelized Grid for .ino Input (Holocube)
// From model: {model_path}

#pragma once
#include <Arduino.h>

const int GRID_SIZE_X = {GRID_SIZE_X};
const int GRID_SIZE_Y = {GRID_SIZE_Y};
const int GRID_SIZE_Z = {GRID_SIZE_Z};

const int POINT_COUNT = {len(grid)};
const uint8_t PROGMEM MODEL_POINTS[POINT_COUNT][3] = {{
{points_formatted}
}};
"""
    output_path.write_text(header_code, encoding="utf-8")

    flash = len(grid) * 3
    print(f"Header successfully saved ({len(grid)} points, ~{flash / 1000:.1f} kB of flash).")
    if flash > FLASH_WARN_BYTES:
        print("Warning: large point array - it may not fit in the ESP32 app partition. "
              "Drop --solid or use a simpler model.")


def main():
    parser = argparse.ArgumentParser(description="Holocube Voxelizer: parse 3D triangular mesh models into "
                                     "128x8x128 point clouds for volumetric display firmware.")
    parser.add_argument("model_input", type=str, help="Path to input .stl/.obj/.gltf/triangular mesh file")
    parser.add_argument("--solid", action="store_true",
                        help="fill each layer's cross-section instead of drawing only its outline")
    parser.add_argument("--axes", default="x,y,z", metavar="X,D,R",
                        help="model axis for display x, depth (layer) and pixel row. Default x,y,z. "
                             "A Z-up model usually wants x,y,-z. Write as --axes=x,y,-z when starting with '-'.")
    parser.add_argument("--output", type=str, default=None,
                        help="output header path (default: model_data.h next to the voxelizer folder)")
    args = parser.parse_args()

    input_file = Path(args.model_input)
    if not input_file.exists():
        print(f"Error: File '{input_file}' not found.")
        raise SystemExit(1)

    output_path = Path(args.output) if args.output else Path(__file__).resolve().parent.parent / "model_data.h"

    try:
        perm, sign = parse_axes(args.axes)
        mesh = load_mesh(input_file)
        if args.solid and not mesh.is_watertight:
            print("Warning: mesh is not watertight; --solid fill may have gaps.")
        mesh, scale, size_px = fit_to_grid(mesh, perm, sign)
        print(f"Scale: {scale:.4f} px per model unit; model occupies {size_px[0]:.1f} x {size_px[1]:.1f} "
              f"(depth, {size_px[1] / LAYER_PITCH_PX:.1f} layer gaps) x {size_px[2]:.1f} px")
        point_cloud = voxelize(mesh, args.solid)
    except ValueError as e:
        print(f"Error: {e}")
        raise SystemExit(1)

    print(f"Point cloud created with {len(point_cloud)} points.")
    generate_header(point_cloud, input_file, output_path)


if __name__ == "__main__":
    main()
