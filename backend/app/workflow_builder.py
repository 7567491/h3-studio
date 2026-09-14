"""组装 H3 13/14 节点 workflow。

完全照搬 run_one.sh 已经在跑的模板,只是把 prompt 字段改成动态输入。
有 ref_image 时变成 14 节点 (新增 LoadImage)。
"""
from typing import Optional
from .config import H3_DEFAULTS as D


def build_h3_workflow(
    prompt_text: str,
    *,
    duration_s: int = 10,
    seed: Optional[int] = None,
    width: Optional[int] = None,
    height: Optional[int] = None,
    ref_image: Optional[str] = None,
) -> dict:
    """构建 H3 Turbo workflow JSON (无 ref 13 节点, 有 ref 14 节点)。

    参数:
        prompt_text: 用户输入的 prompt (有 ref 时必须包含 <Picture 1> 标签)
        duration_s: 目标时长秒数(8 步 Turbo,17 帧/block @ 24fps)
        seed: 随机种子(None 用默认)
        width: 生成宽度 (None = H3_DEFAULTS 默认值, 必须是 32 倍数)
        height: 生成高度 (None = H3_DEFAULTS 默认值, 必须是 32 倍数)
        ref_image: 可选参考图文件名 (上传到 远端 ComfyUI 后的最终文件名, e.g.
                  'h3studio/abc123.jpg')。节点要求 COMFY_AUTOGROW_V3 字段名是
                  **点号键**: "ref_images.ref_image_1" (issue#15305 陷阱: 裸
                  "ref_image_1" 报 TypeError, 嵌套 dict "ref_images:{...}" 静默
                  成功但忽略图)。有 ref 时 prompt 必须包含 <Picture 1> 标签。
    """
    import math

    if not prompt_text.strip():
        raise ValueError("prompt_text 不能为空")

    # 时长 → 帧数,向上对齐到 17 的倍数
    dur_s = max(1, duration_s)
    length = max(81, int(math.ceil(dur_s * D["fps"] / D["frames_per_block"]) * D["frames_per_block"]))
    width = width if width is not None else D["width"]
    height = height if height is not None else D["height"]

    # ComfyUI 节点硬约束: width/height 必须是 32 倍数 (step=32, min=32, max=16384)
    # 注意: Python 里 "x % 32 or y % 32" 是错的 — 0 是 falsy, 整除反而不报错!
    if width % 32 != 0 or height % 32 != 0:
        raise ValueError(
            f"width/height 必须是 32 倍数 (节点硬约束), 收到 {width}x{height}"
        )

    if seed is None:
        import random
        seed = random.randint(0, 2**32 - 1)

    # 节点 101 是 LoadImage (仅 ref_image != None 时创建)
    # 节点 10 的 inputs["ref_images.ref_image_1"] = ["101", 0] 是点号键写法
    extra_nodes = {}
    ref_image_inputs = {}
    if ref_image:
        load_node_id = "101"
        extra_nodes[load_node_id] = {
            "class_type": "LoadImage",
            "inputs": {"image": ref_image},
        }
        ref_image_inputs = {
            f"ref_images.ref_image_{i+1}": [load_node_id, 0]
            for i in range(1)  # 第一版只支持 1 张, 后续可扩到 9
        }

    return {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": D["unet_name"], "weight_dtype": "default"}},
        "2": {"class_type": "VAELoader", "inputs": {"vae_name": D["video_vae"]}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": D["audio_vae"]}},
        "4": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": D["clip_name"], "type": D["clip_type"]}},
        "10": {"class_type": "MiniMaxH3ReferenceToVideo",
               "inputs": {"clip": ["4", 0], "vae": ["2", 0], "audio_vae": ["3", 0],
                          "prompt": prompt_text, "width": width, "height": height, "length": length,
                          "ref_image_size": D["ref_image_size"],
                          **ref_image_inputs}},
        "20": {"class_type": "EmptyMiniMaxH3LatentAV",
               "inputs": {"width": width, "height": height, "length": length}},
        "30": {"class_type": "MiniMaxH3TurboLoRA",
               "inputs": {"model": ["1", 0], "lora_name": D["turbo_lora"],
                          "strength": D["turbo_strength"], "low_vram": D["low_vram"]}},
        "31": {"class_type": "MiniMaxH3SigmaShift",
               "inputs": {"model": ["30", 0], "shift_video": D["shift_video"], "shift_audio": D["shift_audio"]}},
        "40": {"class_type": "MiniMaxH3TurboSampler", "inputs": {}},
        "41": {"class_type": "BasicScheduler",
               "inputs": {"model": ["31", 0], "scheduler": D["scheduler"],
                          "steps": D["steps"], "denoise": D["denoise"]}},
        "42": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "43": {"class_type": "CFGGuider",
               "inputs": {"model": ["31", 0], "positive": ["10", 0],
                          "negative": ["10", 0], "cfg": D["cfg"]}},
        "50": {"class_type": "SamplerCustomAdvanced",
               "inputs": {"noise": ["42", 0], "guider": ["43", 0], "sampler": ["40", 0],
                          "sigmas": ["41", 0], "latent_image": ["20", 0]}},
        # 60+: VAE 解码 → 视频输出 (从 run_one.sh 抓的真实节点定义)
        "60": {"class_type": "VAEDecodeTiled",
               "inputs": {"samples": ["50", 0], "vae": ["2", 0],
                          "tile_size": 256, "overlap": 32,
                          "temporal_size": 64, "temporal_overlap": 8}},
        "61": {"class_type": "VAEDecodeAudio",
               "inputs": {"samples": ["50", 0], "vae": ["3", 0]}},
        "70": {"class_type": "CreateVideo",
               "inputs": {"images": ["60", 0], "fps": float(D["fps"]), "audio": ["61", 0]}},
        "80": {"class_type": "SaveVideo",
               "inputs": {"video": ["70", 0],
                          "filename_prefix": "H3_studio",
                          "format": "mp4", "codec": "h264"}},
        **extra_nodes,
    }