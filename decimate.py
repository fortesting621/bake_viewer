import bpy
import sys
import os
import json
import math
from typing import Any, NamedTuple


class MeshStats(NamedTuple):
    verts: int
    tris: int
    polys: int


def import_model(path: str) -> list[bpy.types.Object]:
    ext = os.path.splitext(path)[1].lower()
    before = {o.name for o in bpy.data.objects}
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


def mesh_stats(objs: list[bpy.types.Object]) -> MeshStats:
    verts = tris = polys = 0
    for o in objs:
        verts += len(o.data.vertices)
        polys += len(o.data.polygons)
        tris += sum(max(len(p.vertices) - 2, 0) for p in o.data.polygons)
    return MeshStats(verts, tris, polys)


def _count_tris(ob: bpy.types.Object) -> int:
    return sum(max(len(p.vertices) - 2, 0) for p in ob.data.polygons)


def _apply_unsudiv(mod: bpy.types.Modifier, cfg: dict[str, Any]) -> None:
    mod.decimate_type = "UNSUBDIV"
    mod.iterations = max(1, int(cfg.get("iterations", 1)))


def _apply_dissolve(mod: bpy.types.Modifier, cfg: dict[str, Any]) -> None:
    mod.decimate_type = "DISSOLVE"
    mod.angle_limit = math.radians(float(cfg.get("angle", 5.0)))
    mod.use_dissolve_boundaries = False


def _apply_target(mod: bpy.types.Modifier, ob: bpy.types.Object,
                  cfg: dict[str, Any], total_objs: int) -> None:
    target_total = max(1, int(cfg.get("target", 0)))
    target_per_obj = max(1, target_total // total_objs)
    tris = _count_tris(ob)
    ratio = min(1.0, target_per_obj / tris) if tris > target_per_obj else 1.0
    mod.decimate_type = "COLLAPSE"
    mod.ratio = ratio
    mod.use_collapse_triangulate = True


def _apply_collapse(mod: bpy.types.Modifier, cfg: dict[str, Any]) -> None:
    mod.decimate_type = "COLLAPSE"
    mod.ratio = min(1.0, max(0.0, float(cfg.get("ratio", 0.5))))
    mod.use_collapse_triangulate = True


def apply_decimate(ob: bpy.types.Object, mode: str, cfg: dict[str, Any],
                   total_objs: int = 1) -> None:
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    mod = ob.modifiers.new("Decimate", "DECIMATE")
    handlers = {
        "UNSUBDIV": lambda: _apply_unsudiv(mod, cfg),
        "DISSOLVE": lambda: _apply_dissolve(mod, cfg),
        "TARGET": lambda: _apply_target(mod, ob, cfg, total_objs),
    }
    handlers.get(mode, lambda: _apply_collapse(mod, cfg))()
    bpy.ops.object.modifier_apply(modifier=mod.name)
    ob.select_set(False)


def export_outputs(objs: list[bpy.types.Object], cfg: dict[str, Any]) -> None:
    bpy.ops.export_scene.gltf(
        filepath=cfg["out_glb"],
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_yup=True,
    )
    out_obj = cfg.get("out_obj")
    if out_obj:
        try:
            bpy.ops.wm.obj_export(filepath=out_obj, export_selected_objects=False)
        except Exception as e:
            print("obj export failed:", e)


def main(cfg: dict[str, Any]) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    objs = import_model(cfg["in"])
    if not objs:
        raise RuntimeError("не найдено мешей в файле")

    before = mesh_stats(objs)
    mode = cfg.get("mode", "COLLAPSE")
    for ob in objs:
        apply_decimate(ob, mode, cfg, len(objs))
    after = mesh_stats(objs)

    export_outputs(objs, cfg)

    print("RESULT " + json.dumps({
        "mode": mode,
        "objects": len(objs),
        "verts_before": before.verts,
        "verts_after": after.verts,
        "tris_before": before.tris,
        "tris_after": after.tris,
        "polys_before": before.polys,
        "polys_after": after.polys,
    }))


if __name__ == "__main__":
    argv = sys.argv
    args = argv[argv.index("--") + 1:] if "--" in argv else []
    cfg = json.loads(args[0]) if args else {}
    main(cfg)
    print("DECIMATE_OK")
