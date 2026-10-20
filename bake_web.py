import bpy
import sys
import os
import json
from typing import Any, TypedDict


class BakeCfg(TypedDict, total=False):
    texture: str | None
    resolution: int
    margin: int
    cage_extrusion: float
    max_ray_distance: float
    out_png: str
    out_glb: str


class MeshStats(TypedDict):
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


def find_basecolor_image(objs: list[bpy.types.Object]) -> bpy.types.Image | None:
    for ob in objs:
        for m in ob.data.materials:
            if not m or m.node_tree is None:
                continue
            bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if not bsdf:
                continue
            inp = bsdf.inputs.get("Base Color")
            if inp and inp.is_linked:
                src = inp.links[0].from_node
                if src.type == "TEX_IMAGE" and src.image and src.image.size[0] > 0:
                    return src.image
    for ob in objs:
        for m in ob.data.materials:
            if not m or m.node_tree is None:
                continue
            for n in m.node_tree.nodes:
                if n.type == "TEX_IMAGE" and n.image and n.image.size[0] > 0:
                    return n.image
    return None


def make_emission_material(name: str, image: bpy.types.Image | None = None,
                           target_node: bool = False) -> bpy.types.Material:
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    out = nt.nodes["Material Output"]
    nt.nodes.remove(nt.nodes["Principled BSDF"])
    em = nt.nodes.new("ShaderNodeEmission")
    em.location = (-200, 200)
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.location = (-450, 200)
    if target_node:
        tex.name = "BAKE_TARGET"
    if image is not None:
        tex.image = image
        tex.image.colorspace_settings.name = "sRGB"
        nt.links.new(tex.outputs["Color"], em.inputs["Color"])
    return m


def setup_gpu(scene: bpy.types.Scene) -> None:
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "OPTIX"
        prefs.get_devices_for_type("OPTIX")
        for d in prefs.devices:
            d.use = True
        scene.cycles.device = "GPU"
    except Exception as e:
        print("GPU fallback:", e)
        scene.cycles.device = "CPU"


def mesh_stats(objs: list[bpy.types.Object]) -> MeshStats:
    polys = tris = verts = 0
    for o in objs:
        verts += len(o.data.vertices)
        polys += len(o.data.polygons)
        tris += sum(max(len(p.vertices) - 2, 0) for p in o.data.polygons)
    return {"polys": polys, "tris": tris, "verts": verts}


def resolve_image(cfg: dict[str, Any], high_objs: list[bpy.types.Object]) -> bpy.types.Image:
    tex_path = cfg.get("texture")
    if tex_path and os.path.exists(tex_path):
        image = bpy.data.images.load(tex_path)
    else:
        image = find_basecolor_image(high_objs)
    if image is None:
        raise RuntimeError("не найдена base color текстура: укажите файл")
    image.colorspace_settings.name = "sRGB"
    return image


def setup_bake(scene: bpy.types.Scene, cfg: dict[str, Any]) -> None:
    scene.render.engine = "CYCLES"
    setup_gpu(scene)
    scene.cycles.samples = 1
    scene.cycles.use_denoising = False
    scene.view_settings.view_transform = "Standard"
    b = scene.render.bake
    b.margin = int(cfg.get("margin", 32))
    b.use_selected_to_active = True
    b.cage_extrusion = float(cfg.get("cage_extrusion", 0.008))
    b.max_ray_distance = float(cfg.get("max_ray_distance", 0.012))


def bake_low_objects(low_objs: list[bpy.types.Object],
                     high_objs: list[bpy.types.Object]) -> None:
    b = bpy.context.scene.render.bake
    for i, lo in enumerate(low_objs):
        for o in bpy.data.objects:
            o.select_set(o == lo or o in high_objs)
        bpy.context.view_layer.objects.active = lo
        b.use_clear = (i == 0)
        bpy.ops.object.bake(type="EMIT")


def export_low_glb(low_objs: list[bpy.types.Object], out_glb: str) -> None:
    for o in bpy.data.objects:
        o.select_set(o in low_objs)
    bpy.context.view_layer.objects.active = low_objs[0]
    bpy.ops.export_scene.gltf(
        filepath=out_glb,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
    )


def main(cfg: dict[str, Any]) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene

    high_objs = import_model(cfg["high"])
    low_objs = import_model(cfg["low"])
    if not high_objs:
        raise RuntimeError("high poly: не найдено мешей")
    if not low_objs:
        raise RuntimeError("low poly: не найдено мешей")

    image = resolve_image(cfg, high_objs)

    mat_h = make_emission_material("H_mat", image=image)
    for ob in high_objs:
        ob.data.materials.clear()
        ob.data.materials.append(mat_h)

    res = int(cfg.get("resolution", 4096))
    result_img = bpy.data.images.new("bake_result", res, res, alpha=False)
    result_img.colorspace_settings.name = "sRGB"

    mat_l = make_emission_material("L_mat", target_node=True)
    for ob in low_objs:
        ob.data.materials.clear()
        ob.data.materials.append(mat_l)

    nt = mat_l.node_tree
    tgt = nt.nodes["BAKE_TARGET"]
    tgt.image = result_img
    for n in nt.nodes:
        n.select = False
    tgt.select = True
    nt.nodes.active = tgt

    setup_bake(scene, cfg)
    bake_low_objects(low_objs, high_objs)

    result_img.filepath_raw = cfg["out_png"]
    result_img.file_format = "PNG"
    result_img.save()

    export_low_glb(low_objs, cfg["out_glb"])

    result = {
        "high_objects": [o.name for o in high_objs],
        "low_objects": [o.name for o in low_objs],
        "texture": image.name,
        "resolution": res,
        "low_stats": mesh_stats(low_objs),
        "high_stats": mesh_stats(high_objs),
    }
    print("RESULT " + json.dumps(result))


if __name__ == "__main__":
    argv = sys.argv
    args = argv[argv.index("--") + 1:] if "--" in argv else []
    cfg = json.loads(args[0]) if args else {}
    main(cfg)
    print("BAKE_OK")
