import bpy
import sys
import os
import json
import math


def import_model(path):
    ext = os.path.splitext(path)[1].lower()
    before = set(o.name for o in bpy.data.objects)
    if ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".stl":
        bpy.ops.wm.stl_import(filepath=path)
    else:
        bpy.ops.import_scene.fbx(filepath=path)
    return [o for o in bpy.data.objects if o.name not in before and o.type == "MESH"]


def mesh_stats(objs):
    verts = 0
    tris = 0
    polys = 0
    for o in objs:
        verts += len(o.data.vertices)
        polys += len(o.data.polygons)
        tris += sum(max(len(p.vertices) - 2, 0) for p in o.data.polygons)
    return verts, tris, polys


def apply_decimate(ob, mode, cfg, obj_index=0, total_objs=1):
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    mod = ob.modifiers.new("Decimate", "DECIMATE")
    if mode == "UNSUBDIV":
        mod.decimate_type = "UNSUBDIV"
        mod.iterations = max(1, int(cfg.get("iterations", 1)))
    elif mode == "DISSOLVE":
        mod.decimate_type = "DISSOLVE"
        mod.angle_limit = math.radians(float(cfg.get("angle", 5.0)))
        mod.use_dissolve_boundaries = False
    elif mode == "TARGET":
        target_total = max(1, int(cfg.get("target", 0)))
        # target is total for all objects; divide evenly
        target_per_obj = max(1, target_total // total_objs)
        # count triangles in this object
        tris = sum(max(len(p.vertices) - 2, 0) for p in ob.data.polygons)
        print(f"[TARGET] obj={ob.name}, tris={tris}, target_per_obj={target_per_obj}")
        if tris > target_per_obj:
            ratio = min(1.0, target_per_obj / tris)
        else:
            ratio = 1.0
        print(f"[TARGET] ratio={ratio}")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
    else:
        mod.decimate_type = "COLLAPSE"
        mod.ratio = min(1.0, max(0.0, float(cfg.get("ratio", 0.5))))
        mod.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=mod.name)
    ob.select_set(False)


def main(cfg):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    objs = import_model(cfg["in"])
    if not objs:
        raise RuntimeError("не найдено мешей в файле")

    v0, t0, p0 = mesh_stats(objs)
    mode = cfg.get("mode", "COLLAPSE")
    n_objs = len(objs)
    for i, ob in enumerate(objs):
        apply_decimate(ob, mode, cfg, i, n_objs)
    v1, t1, p1 = mesh_stats(objs)

    out_glb = cfg["out_glb"]
    out_obj = cfg.get("out_obj")
    bpy.ops.export_scene.gltf(
        filepath=out_glb,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_yup=True,
    )
    if out_obj:
        try:
            bpy.ops.wm.obj_export(filepath=out_obj, export_selected_objects=False)
        except Exception as e:
            print("obj export failed:", e)

    print("RESULT " + json.dumps({
        "mode": mode,
        "objects": len(objs),
        "verts_before": v0,
        "verts_after": v1,
        "tris_before": t0,
        "tris_after": t1,
        "polys_before": p0,
        "polys_after": p1,
    }))


if __name__ == "__main__":
    argv = sys.argv
    args = argv[argv.index("--") + 1:] if "--" in argv else []
    cfg = json.loads(args[0]) if args else {}
    main(cfg)
    print("DECIMATE_OK")
