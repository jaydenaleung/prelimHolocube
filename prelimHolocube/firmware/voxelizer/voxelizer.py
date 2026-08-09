import argparse
from pathlib import Path
import numpy as np
import trimesh

# attach to logger so trimesh messages will be printed to console
trimesh.util.attach_to_log()

# Grid size
GRID_SIZE_X = 128
GRID_SIZE_Y = 8
GRID_SIZE_Z = 128

def voxelize_model(model_path: Path):
    # Load mesh
    print(f"Loading model: {model_path}")
    loaded = trimesh.load(model_path)

    # Check for scene containers
    if isinstance(loaded, trimesh.Scene):
        mesh = loaded.dump(concatenate=True)
    else:
        mesh = loaded

    print("Load successful.")

    # Account for grid size and pitch (distance between voxel centers)
    pitch = mesh.extents[0] / GRID_SIZE_X
    print(f"Original mesh bounding box extents: {mesh.extents}")
    print(f"Pitch: {pitch}")

    # Voxelize mesh into 128x128x128 grid
    voxel_grid = mesh.voxelized(pitch=pitch)

    # Get integer grid indices [x, y, z] for display
    grid_indices = np.argwhere(voxel_grid.matrix).astype(np.uint8)

    # Final model grid - takes 128x128x128 grid and samples 8 slices for y-direction
    y_pitch = GRID_SIZE_X // GRID_SIZE_Y

    y_mask = (grid_indices[:, 1] % y_pitch == 0) # create True/False mask
    model_grid = grid_indices[y_mask].copy() # delete pixels which don't match the mask (are False)
    model_grid[:, 1] = model_grid[:, 1] // 16 # divide y-coords by 16

    # Masks out points outside grid as safety check
    outer_mask = ((model_grid[:,0] >= 0) & (model_grid[:,0] < GRID_SIZE_X) & (model_grid[:,1] >= 0) & (model_grid[:,1] < GRID_SIZE_Y) & (model_grid[:,2] >= 0) & (model_grid[:,2] < GRID_SIZE_Z))
    model_grid = model_grid[outer_mask]

    print(f"Point cloud created with {len(model_grid)} points.")

    return model_grid

def generate_header(grid: np.ndarray, model_path: Path):
    # Prepare path
    output_path = Path(__file__).resolve().parent.parent / "model_data.h"

    print(f"Output path: {output_path.resolve()}")

    # Format points into C++ array format ({{ braces are escape braces): {{x1,y1,z1},{x2,y2,z2}, ... ,{xn-1,yn-1,yn-1},{xn,y,zn}}
    points_formatted = ",\n".join(
        f"    {{{pt[0]}, {pt[1]}, {pt[2]}}}" for pt in grid
    )

    # Build full text
    header_code = f"""// .h Header File with 128x8x128 Voxelized Grid for .ino Input (Holocube)
// From model: {model_path}

#pragma once

const int GRID_SIZE_X = {GRID_SIZE_X};
const int GRID_SIZE_Y = {GRID_SIZE_Y};
const int GRID_SIZE_Z = {GRID_SIZE_Z};

const int POINT_COUNT = {len(grid)};
const uint8_t PROGMEM MODEL_POINTS[POINT_COUNT][3] = {{
{points_formatted}
}};
"""

    # Write to file
    output_path.write_text(header_code, encoding="utf-8")

    print("Header successfully saved.")

if __name__ == "__main__":
    # Terminal arguments
    parser = argparse.ArgumentParser(description="Holocube Voxelizer: Parse 3D triangular mesh models into 128x8x128 point clouds for volumetric display firmware.")
    parser.add_argument("model_input", type=str, help="Path to input .stl/.obj/.gltf/triangular mesh file")

    args = parser.parse_args()

    # Check if file exists
    input_file = Path(args.model_input)
    if not input_file.exists():
        print(f"Error: File '{input_file}' not found.")
        exit(1)

    # Voxelize model and generate header file
    point_cloud = voxelize_model(input_file)
    generate_header(point_cloud,input_file)