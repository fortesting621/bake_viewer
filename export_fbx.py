import bpy
import sys
import json
import os
import tempfile
from typing import Any, Final


FILE_EXT: Final[dict[str, str]] = {
    "PNG": ".png",
    "JPEG": ".jpg",
    "BMP": ".bmp",
    "TARGA": ".tga",
    "TIFF": ".tif",
}


def linear_to_srgb(c: float) -> float:
    return c * 12.92 if c <= 0.0031308 else 1.055 * (c ** (1.0 / 2.4)) - 0.055


def remove_aux_collection() -> None:
    aux = bpy.data.collections.get("glTF_not_exported")
    if aux is None:
        return
    for obj in list(aux.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.collections.remove(aux)


def flatten_empty_armature_parents() -> None:
    for obj in list(bpy.data.objects):
        if obj.type != "EMPTY":
            continue
        if not any(child.type == "ARMATURE" for child in obj.children):
            continue
        for child in list(obj.children):
            world = child.matrix_world.copy()
            child.parent = obj.parent
            child.matrix_world = world
        bpy.data.objects.remove(obj, do_unlink=True)


def flatten_all_empty_parents() -> None:
    """Apply parent transform to children and remove empty parents that have no animation/armature purpose."""
    for obj in list(bpy.data.objects):
        if obj.type != "EMPTY":
            continue
        if not obj.children:
            continue
        # Keep empties that have armature children (handled by flatten_empty_armature_parents)
        if any(child.type == "ARMATURE" for child in obj.children):
            continue
        # Keep empties with custom properties or constraints (likely rig-related)
        if obj.constraints or obj.keys():
            continue
        for child in list(obj.children):
            world = child.matrix_world.copy()
            child.parent = obj.parent
            child.matrix_world = world
        bpy.data.objects.remove(obj, do_unlink=True)


def remove_cage_and_dummy_objects() -> None:
    for obj in list(bpy.data.objects):
        if obj.name == "__cage__":
            bpy.data.objects.remove(obj, do_unlink=True)
            continue
        if obj.type == "EMPTY" and not obj.children:
            bpy.data.objects.remove(obj, do_unlink=True)


def unwrap_multiply_factor(node: bpy.types.Node, base: bpy.types.NodeSocket) -> None:
    src = base.links[0].from_node
    if src.type not in ("MIX", "MIX_RGB") or src.blend_type != "MULTIPLY":
        return
    texture = None
    factor = None
    for inp in src.inputs:
        if inp.type != "RGBA":
            continue
        if inp.links and inp.links[0].from_node.type == "TEX_IMAGE":
            texture = inp.links[0].from_node
        elif not inp.links:
            factor = inp.default_value
    if texture is None:
        return
    tree = node.id_data
    tree.links.new(texture.outputs["Color"], base)
    if factor is not None:
        base.default_value = (
            linear_to_srgb(factor[0]),
            linear_to_srgb(factor[1]),
            linear_to_srgb(factor[2]),
            factor[3],
        )


def fix_materials() -> None:
    for mat in bpy.data.materials:
        tree = mat.node_tree
        if tree is None:
            continue
        for node in tree.nodes:
            if node.type != "BSDF_PRINCIPLED":
                continue
            if "Metallic" in node.inputs:
                node.inputs["Metallic"].default_value = 0.0
            if "Emission Strength" in node.inputs and not node.inputs["Emission Strength"].links:
                node.inputs["Emission Strength"].default_value = 0.0
            base = node.inputs.get("Base Color")
            if base is not None and base.links:
                unwrap_multiply_factor(node, base)


def save_embedded_textures() -> None:
    for image in bpy.data.images:
        if image.source != "FILE" or os.path.splitext(image.filepath)[1]:
            continue
        fmt = image.file_format if image.file_format in FILE_EXT else "PNG"
        name = os.path.splitext(os.path.basename(image.name))[0] or "texture"
        image.filepath_raw = os.path.join(tempfile.gettempdir(), name + FILE_EXT[fmt])
        image.file_format = fmt
        image.save()


def main(cfg: dict[str, Any]) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=cfg["in"])
    remove_aux_collection()
    flatten_empty_armature_parents()
    flatten_all_empty_parents()
    remove_cage_and_dummy_objects()
    fix_materials()
    save_embedded_textures()
    bpy.ops.export_scene.fbx(
        filepath=cfg["out"],
        use_selection=False,
        bake_anim=True,
        add_leaf_bones=False,
        path_mode="COPY",
        embed_textures=True,
    )
    print("FBX_OK " + cfg["out"])


if __name__ == "__main__":
    argv = sys.argv
    args = argv[argv.index("--") + 1:] if "--" in argv else []
    cfg = json.loads(args[0]) if args else {}
    main(cfg)
