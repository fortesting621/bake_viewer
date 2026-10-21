import bpy
import json
import os
import re
import sys
from typing import Any, TypedDict


class BakeCfg(TypedDict, total=False):
    low: str
    high: str
    texture: str | None
    maps: list[str]
    textures: dict[str, str | None]
    cage_extrusion: float
    max_ray_distance: float
    margin: int
    resolution: int
    out_png: str
    out_pngs: dict[str, str]
    out_glb: str


class MeshStats(TypedDict):
    verts: int
    tris: int
    polys: int


# id карты -> (название, colorspace). Данные карты (normal/ao/roughness/metallic/height)
# несут значения, а не цвет: для них обязательно Non-Color, иначе значения искажаются.
MAP_SPECS: dict[str, tuple[str, str]] = {
    "basecolor": ("Base color", "sRGB"),
    "normal": ("Normal", "Non-Color"),
    "ao": ("AO", "Non-Color"),
    "roughness": ("Roughness", "Non-Color"),
    "metallic": ("Metallic", "Non-Color"),
    "height": ("Height", "Non-Color"),
}

AO_TOKENS = {"ao", "aomap", "occlusion", "ambient"}
HEIGHT_TOKENS = {"height", "heightmap", "displacement", "disp", "dispmap"}


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


def materials_of(objs: list[bpy.types.Object]) -> list[bpy.types.Material]:
    out: list[bpy.types.Material] = []
    for ob in objs:
        for m in ob.data.materials:
            if m is not None and m.node_tree is not None and m not in out:
                out.append(m)
    return out


def socket_image(inp: bpy.types.NodeSocket | None) -> bpy.types.Image | None:
    """Ищет текстуру выше по графу нод: BSDF -> Normal Map -> Image Texture."""
    seen: set[tuple[str, str]] = set()
    stack: list[bpy.types.NodeSocket] = [inp] if inp is not None else []
    while stack:
        sock = stack.pop()
        key = (sock.node.name, sock.identifier)
        if key in seen:
            continue
        seen.add(key)
        for link in sock.links:
            node = link.from_node
            if node.type == "TEX_IMAGE":
                img = node.image
                if img is not None and img.size[0] > 0:
                    return img
            stack.extend(node.inputs)
    return None


def principled_socket_image(objs: list[bpy.types.Object], socket: str) -> bpy.types.Image | None:
    for mat in materials_of(objs):
        for node in mat.node_tree.nodes:
            if node.type != "BSDF_PRINCIPLED":
                continue
            img = socket_image(node.inputs.get(socket))
            if img is not None:
                return img
    return None


def any_image(objs: list[bpy.types.Object]) -> bpy.types.Image | None:
    for mat in materials_of(objs):
        for node in mat.node_tree.nodes:
            if node.type == "TEX_IMAGE" and node.image and node.image.size[0] > 0:
                return node.image
    return None


def name_matches(names: list[str], tokens: set[str]) -> bool:
    for raw in names:
        parts = [p for p in re.split(r"[^a-z0-9]+", raw.lower()) if p]
        if any(p in tokens for p in parts):
            return True
    return False


def find_image_by_tokens(objs: list[bpy.types.Object], tokens: set[str]) -> bpy.types.Image | None:
    """Ищет текстуру по имени ноды/файла (AO и Height в high-poly часто на отдельном материале)."""
    for mat in materials_of(objs):
        for node in mat.node_tree.nodes:
            if node.type != "TEX_IMAGE" or not node.image or node.image.size[0] == 0:
                continue
            img = node.image
            names = [node.name, node.label or "", img.name, os.path.basename(img.filepath or "")]
            if name_matches(names, tokens):
                return img
    return None


def autodetect_source(map_id: str, high_objs: list[bpy.types.Object]) -> bpy.types.Image | None:
    if map_id == "basecolor":
        return principled_socket_image(high_objs, "Base Color") or any_image(high_objs)
    if map_id == "normal":
        return principled_socket_image(high_objs, "Normal")
    if map_id == "roughness":
        return principled_socket_image(high_objs, "Roughness")
    if map_id == "metallic":
        return principled_socket_image(high_objs, "Metallic")
    if map_id == "ao":
        return find_image_by_tokens(high_objs, AO_TOKENS)
    if map_id == "height":
        return find_image_by_tokens(high_objs, HEIGHT_TOKENS)
    return None


def resolve_source(cfg: BakeCfg, map_id: str, high_objs: list[bpy.types.Object]) -> bpy.types.Image:
    """Источник карты: загруженный файл, иначе автоподцеп из high poly."""
    label, colorspace = MAP_SPECS[map_id]
    path = (cfg.get("textures") or {}).get(map_id)
    if not path and map_id == "basecolor":
        path = cfg.get("texture")
    if path and os.path.exists(path):
        image = bpy.data.images.load(path, check_existing=False)
    else:
        image = autodetect_source(map_id, high_objs)
    if image is None:
        raise RuntimeError(f"нет источника для карты «{label}»: загрузите файл вручную")
    image.colorspace_settings.name = colorspace
    return image


def make_emission_material(name: str, image: bpy.types.Image | None = None,
                           target_node: bool = False, colorspace: str = "sRGB") -> bpy.types.Material:
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
        tex.image.colorspace_settings.name = colorspace
        nt.links.new(tex.outputs["Color"], em.inputs["Color"])
    return m


def set_bake_target(mat: bpy.types.Material, image: bpy.types.Image) -> None:
    nt = mat.node_tree
    tgt = nt.nodes["BAKE_TARGET"]
    tgt.image = image
    for n in nt.nodes:
        n.select = False
    tgt.select = True
    nt.nodes.active = tgt


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


def setup_bake(scene: bpy.types.Scene, cfg: BakeCfg) -> None:
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


def bake_map(map_id: str, source: bpy.types.Image, res: int,
             low_objs: list[bpy.types.Object],
             high_objs: list[bpy.types.Object]) -> bpy.types.Image:
    """Перепекает одну карту: проекция исходной текстуры через high-poly (Selected to Active)."""
    _, colorspace = MAP_SPECS[map_id]
    result = bpy.data.images.new("bake_" + map_id, res, res, alpha=False)
    result.colorspace_settings.name = colorspace

    mat_h = make_emission_material("H_" + map_id, image=source, colorspace=colorspace)
    for ob in high_objs:
        ob.data.materials.clear()
        ob.data.materials.append(mat_h)

    mat_l = make_emission_material("L_" + map_id, target_node=True)
    for ob in low_objs:
        ob.data.materials.clear()
        ob.data.materials.append(mat_l)
    set_bake_target(mat_l, result)

    bake_low_objects(low_objs, high_objs)
    return result


def save_png(image: bpy.types.Image, path: str) -> None:
    image.filepath_raw = path
    image.file_format = "PNG"
    image.save()


def build_final_material(images: dict[str, bpy.types.Image]) -> bpy.types.Material:
    """Материал low-poly с запечёнными картами (для экспорта GLB)."""
    m = bpy.data.materials.new("L_baked")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    for map_id, image in images.items():
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = image
        node.location = (-600, 0)
        if map_id == "basecolor":
            nt.links.new(node.outputs["Color"], bsdf.inputs["Base Color"])
        elif map_id == "roughness":
            nt.links.new(node.outputs["Color"], bsdf.inputs["Roughness"])
        elif map_id == "metallic":
            nt.links.new(node.outputs["Color"], bsdf.inputs["Metallic"])
        elif map_id == "normal":
            nm = nt.nodes.new("ShaderNodeNormalMap")
            nm.location = (-350, -250)
            nt.links.new(node.outputs["Color"], nm.inputs["Color"])
            nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    return m


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


def main(cfg: BakeCfg) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene

    high_objs = import_model(cfg["high"])
    low_objs = import_model(cfg["low"])
    if not high_objs:
        raise RuntimeError("high poly: не найдено мешей")
    if not low_objs:
        raise RuntimeError("low poly: не найдено мешей")

    maps = [m for m in cfg.get("maps", []) if m in MAP_SPECS] or ["basecolor"]
    res = int(cfg.get("resolution", 4096))
    setup_bake(scene, cfg)

    sources = {mid: resolve_source(cfg, mid, high_objs) for mid in maps}
    results = {mid: bake_map(mid, sources[mid], res, low_objs, high_objs) for mid in maps}

    out_pngs = cfg.get("out_pngs") or {}
    for mid, image in results.items():
        path = out_pngs.get(mid) or cfg.get("out_png")
        if path:
            save_png(image, path)

    final = build_final_material(results)
    for ob in low_objs:
        ob.data.materials.clear()
        ob.data.materials.append(final)
    export_low_glb(low_objs, cfg["out_glb"])

    result = {
        "high_objects": [o.name for o in high_objs],
        "low_objects": [o.name for o in low_objs],
        "maps": maps,
        "resolution": res,
        "low_stats": mesh_stats(low_objs),
        "high_stats": mesh_stats(high_objs),
    }
    print("RESULT " + json.dumps(result))


if __name__ == "__main__":
    argv = sys.argv
    args = argv[argv.index("--") + 1:] if "--" in argv else []
    raw: Any = json.loads(args[0]) if args else {}
    main(raw)
    print("BAKE_OK")
