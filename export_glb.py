import bpy
import os

DESK: str = r"C:\Users\user\Desktop\bake"
LOW_FBX: str = os.path.join(DESK, "l.fbx")
OUT_GLB: str = os.path.join(DESK, "bake_viewer", "web", "model.glb")
LOW_NAME: str = "mesh_rep_0_ori_repair_quad"

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=LOW_FBX)
low = bpy.data.objects[LOW_NAME]

low.data.materials.clear()

for ob in bpy.data.objects:
    ob.select_set(ob == low)
bpy.context.view_layer.objects.active = low

bpy.ops.export_scene.gltf(
    filepath=OUT_GLB,
    export_format="GLB",
    use_selection=True,
    export_apply=True,
    export_yup=True,
)
print("EXPORT_OK", OUT_GLB)
