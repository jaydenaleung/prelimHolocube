/*
NOTE: THIS SCRIPT ONLY RUNS WHEN PLAY IS PRESSED INSIDE THE UNITY EDITOR.
NOTE: READ/WRITE OPTION MUST BE ENABLED ON THE IMPORT SETTINGS FOR THE MODEL YOU WISH TO EXPORT IN UNITY. CLICK ON THE MODEL AND CHECK THE READ/WRITE BOX IN THE INSPECTOR, THEN CLICK APPLY.
*/


using UnityEngine;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Text;

public class pointCloudExporter : MonoBehaviour
{
    public float scale = 1.0f; // Scale factor exporting for different display sizes
    public float pitch = 0.01f; // coarseness/resolution of points within triangles, measured in the units the Unity Editor is using

    private List<Vector3> fillTriangles(Vector3 v0, Vector3 v1, Vector3 v2)
    {
        // find the longest side
        Vector3 a = v1 - v0; // Vector from v0 to v1
        Vector3 b = v2 - v1; // Vector from v1 to v2
        Vector3 c = v2 - v0; // Vector from v0 to v2
        float lenSqA = a.sqrMagnitude; // Distance between v0 and v1
        float lenSqB = b.sqrMagnitude; // Distance between v1 and v2
        float lenSqC = c.sqrMagnitude; // Distance between v0 and v2
        float maxSqSideLength = Mathf.Max(lenSqA, lenSqB, lenSqC); // Find the longest side
        float maxSideLength = Mathf.Sqrt(maxSqSideLength);

        Vector3 edgeStart,edgeEnd,point;
        if (Mathf.Approximately(maxSqSideLength, lenSqA)) {
            edgeStart = v0;
            edgeEnd = v1;
            point = v2;
        } else if (Mathf.Approximately(maxSqSideLength, lenSqB)) {
            edgeStart = v1;
            edgeEnd = v2;
            point = v0;
        } else {
            edgeStart = v0;
            edgeEnd = v2;
            point = v1;
        }

        // find the perpendicular length of the line from the point not included in the longest side to the longest side
        float height = Vector3.Cross(edgeEnd-edgeStart,edgeStart-point).magnitude/(edgeEnd-edgeStart).magnitude; // using cross product

        // find the number of dots along the sides of the triangle and within the area of the rectangle those sides form
        int dotsB = (int)(maxSideLength/pitch) + 1; // number of dots along the 'base' of the triangle (longest side), truncated - the +1 is for the extra point that needs to be generated at the end of the line of height/maxSideLength
        int dotsH = (int)(height/pitch) + 1; // number of dots along the 'height' of the triangle (perpendicular to base), truncated

        // create an array with all the dots
        List<Vector3> dots = new List<Vector3>();

        Vector3 baseVec = (edgeEnd - edgeStart).normalized; // unit vector direction along the base
        Vector3 perpVec = (point - edgeStart) - Vector3.Dot(point - edgeStart, baseVec) * baseVec;  // unit vector direction along the height, but starting from edgeStart
        perpVec.Normalize(); // direction perpendicular to base

        for (int i = 0; i < dotsB; i++)
        {
            for (int j = 0; j < dotsH; j++)
                {
                    Vector3 dot = edgeStart + baseVec * (i * pitch) + perpVec * (j * pitch);
                    dots.Add(dot);
                }
        }

        // remove the dots that are not inside the triangle
        List<Vector3> insideDots = new List<Vector3>();
        foreach (Vector3 dot in dots)
        {
            Vector3 s0 = a;
            Vector3 s1 = c;
            Vector3 s2 = dot - v0;

            float d00 = Vector3.Dot(s0, s0);
            float d01 = Vector3.Dot(s0, s1);
            float d11 = Vector3.Dot(s1, s1);
            float d20 = Vector3.Dot(s2, s0);
            float d21 = Vector3.Dot(s2, s1);

            float denom = d00 * d11 - d01 * d01;
            float v = (d11 * d20 - d01 * d21) / denom;
            float w = (d00 * d21 - d01 * d20) / denom;
            float u = 1.0f - v - w;

            if (u >= 0 && v >= 0 && w >= 0 && u <= 1 && v <= 1 && w <= 1)
            { // P is inside
                insideDots.Add(dot);
            }
        }

        return insideDots;
    }

    void Start() 
    {
        string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
        string exportFolder = Path.Combine(projectRoot, "PointCloudExports");
        string filePath = Path.Combine(exportFolder, gameObject.name + "_pointcloud.xyz");

        using (StreamWriter writer = new StreamWriter(filePath)) // system file writer
        {
            MeshFilter[] meshFilters = GetComponentsInChildren<MeshFilter>(); // locates all meshfilters inside to loop over

            foreach (MeshFilter mf in meshFilters)
            {
                Mesh mesh = mf.sharedMesh; // grabs a reference to the actual mesh inside meshfilter
                if (mesh == null) continue; // safety check if there is no mesh

                Vector3[] vertices = mesh.vertices;
                int[] triangles = mesh.triangles; // triangles saved in an int[] - the first triangle is vertices[triangles[0]], etc.

                List<Vector3> skeletonPoints = new List<Vector3>();
                foreach (Vector3 v in vertices) // loop over the vertices and write their positions to the file
                {
                    Vector3 worldPos = mf.transform.TransformPoint(v * scale); // transform local mesh coords to global world coords
                    skeletonPoints.Add(worldPos);
                }

                List<Vector3> filledPoints = new List<Vector3>();
                for (int i = 0; i < triangles.Length; i += 3) // loop over the triangles and sample points within them
                {
                    Vector3 v0 = mf.transform.TransformPoint(vertices[triangles[i]] * scale);
                    Vector3 v1 = mf.transform.TransformPoint(vertices[triangles[i+1]] * scale);
                    Vector3 v2 = mf.transform.TransformPoint(vertices[triangles[i+2]] * scale);

                    List<Vector3> pts = fillTriangles(v0,v1,v2);

                    foreach(Vector3 p in pts)
                    {
                        filledPoints.Add(p);
                    }
                }

                // combine the point clouds
                List<Vector3> totalPoints = new List<Vector3>();
                totalPoints.AddRange(skeletonPoints);
                totalPoints.AddRange(filledPoints);

                // filter out duplicates
                totalPoints = totalPoints.Distinct().ToList();

                // write the points to a .xyz file
                StringBuilder sb = new StringBuilder();
                int batchSize = 5000;
                int count = 0;

                foreach (Vector3 dot in totalPoints)
                {
                    sb.AppendLine($"{dot.x} {dot.y} {dot.z}");
                    count++;
                    if (count >= batchSize)
                    {
                        writer.Write(sb.ToString());
                        sb.Clear();
                        count = 0;
                    }
                }

                if (sb.Length > 0)
                    writer.Write(sb.ToString());
            }
        }

        Debug.Log("Export complete: " + filePath);
    }
}