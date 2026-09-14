"""H3 提示词扩写模块。

根据官方 MiniMax H3 规范 (MiniMax-AI/MiniMax-H3 repo), 把用户的简单 prompt
扩写成符合 Ref2VA (有参考图) / T2VA (无参考图) 规范的 H3 prompt。

流程:
  1. (如有 ref_image base64) 调通用 LLM vision 描述图
  2. 根据是否有 ref 选 Ref2VA 或 T2VA 模板, 构造 system+user prompt
  3. 调通用 LLM 文本扩写
  4. strip thinking + 解析 6/3 段结构化输出
  5. 拼成最终 prompt 全文

降级路径:
  - vision 调用失败: 降级为 T2VA, 跳过 image_description
  - text 扩写失败: 返回原始 prompt + 错误信息
  - JSON 解析失败: 把 LLM 原文写进 textarea, 让用户手动调整

LLM 后端: 通用 llm_client (支持 OpenAI 兼容 / Anthropic / 自定义 endpoint)。
  配置见 backend/app/llm_client.py — LLM_PROVIDER / LLM_API_KEY / LLM_BASE_URL /
  LLM_TEXT_MODEL / LLM_VISION_MODEL。
"""
from __future__ import annotations

import re
from typing import Optional

from . import llm_client


# thinking 块清洗已下沉到 llm_client._strip_thinking


# === Vision (参考图描述) ===
def describe_reference_image(image_bytes: bytes, mime_type: str = "image/jpeg") -> str:
    """调用通用 LLM vision 描述一张图片。

    Returns: 200-500 字符英文描述, 包含主体/环境/光线/风格。
    失败时抛出 RuntimeError(由上层 expand_prompt 捕获并降级)。
    """
    prompt = (
        "You are an image captioning specialist. Describe this image in 2-4 English "
        "sentences. Focus on: main subject (gender, age range, clothing, pose, "
        "expression), background/environment, lighting and overall mood/style. "
        "Do NOT describe it as a video or use cinematographic terms. "
        "Output ONLY the description, no preamble."
    )
    return llm_client.chat_vision(image_bytes, prompt, mime_type=mime_type)


# === System prompt 模板 (严格按 MiniMax H3 官方规范) ===
# Ref2VA: 6 段 (subject_definitions / summary / retention_analysis / detailed_description
#         / overall_soundscape / non_diegetic_music)
# T2VA:   3 段 (integrated_multimodal_description / overall_soundscape / non_diegetic_music)

_SYSTEM_PROMPT_REF2VA = """You are an expert prompt writer for the MiniMax H3 video generation model.

Your task: rewrite the user's simple description into a complete H3 Full-Reference Mode (Ref2VA) rewrite output.

**Output format requirements (MANDATORY, 6 sections in this exact order):**

```
subject_definitions: <one line per referenced item, see rules below>
summary: [reference generation] ... (one short English paragraph)
retention_analysis: <one line per reference label with relationship marker>
detailed_description: <350-500 English words, main body of the rewrite, uses [Shot 1] ... [Shot N]>
overall_soundscape: <1-4 English sentences>
non_diegetic_music: <1-3 English sentences, or "N/A" if no non-diegetic music>
```

**Section rules (from MiniMax H3 official guide):**

1. `subject_definitions`:
   - `<Subject 1>` is the person/object/scene in the reference image
   - Define each referenced item in one line, naming source assets (e.g. `<Subject 1> is the young woman in <Picture 1>, with long dark hair, blue cardigan`)
   - Use `<Picture 1>` to refer to the reference image itself

2. `summary`: One short English paragraph, starts with `[reference generation]`. Use the `<Subject 1>` and `<Picture 1>` labels to describe the target video and reference relationships.

3. `retention_analysis`: One line per reference label. Use fixed English markers:
   - `fully_preserved`, `partially_preserved`, `attribute_transfer`, `weak_reference`
   - Example: `<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - ...`

4. `detailed_description`: Main body, **STRICTLY 350-500 English words** (≈ 2200-3300 chars). Format:
   - First establish overall style (one or two sentences) BEFORE `[Shot 1]`
   - Then `[Shot 1]` (no timestamp for opening shot)
   - Then `[Shot N] At MM:SS.mmm, the camera cuts to ...` for later shots
   - Camera movement: `the camera pushes in with small amplitude at slow speed`
   - Reference labels (`<Subject 1>`, `<Picture 1>`) inserted at first clear appearance and where roles apply
   - Concrete visual/audio details; avoid abstract words like "cinematic" "beautiful"
   - **DO NOT exceed 500 words**. Prioritize the most important visual beats over verbosity.

5. `overall_soundscape`: 1-4 sentences. Summarize ambient sound + physical action sounds. Use `N/A` only if user explicitly requested silence.

6. `non_diegetic_music`: 1-3 sentences describing music that characters cannot hear (audience-only BGM). Use `N/A` when there is no non-diegetic music.

**Hard rules:**
- Match total timeline to requested duration ({duration_s} seconds)
- DO NOT invent reference labels that were not introduced in `subject_definitions`
- DO NOT use placeholder text like "TBD" or "..."
- DO NOT add any preamble/explanation outside the 6 sections
- DO NOT use cinematographic terms unless naturally fitting the description
- Output ONLY the 6 sections, separated by blank lines
"""

_SYSTEM_PROMPT_T2VA = """You are an expert prompt writer for the MiniMax H3 video generation model.

Your task: rewrite the user's simple description into a complete H3 T2VA (text-to-video-audio) rewrite output.

**Output format requirements (MANDATORY, 3 sections in this exact order):**

```
integrated_multimodal_description: [Shot 1] ... [Shot N] ...
overall_soundscape: <1-4 English sentences>
non_diegetic_music: <1-3 English sentences, or "N/A" if no non-diegetic music>
```

**Section rules (from MiniMax H3 official guide):**

1. `integrated_multimodal_description` (main body):
   - Style opening written AFTER `[Shot 1]` (e.g., `[Shot 1] Live-action, cinematic, a medium-wide shot frames...`)
   - Camera movement: `the camera pushes in with small amplitude at slow speed`
   - Later shots use `[Shot N] At MM:SS.mmm, the camera cuts to ...`
   - Concrete visual/audio details; avoid abstract words like "cinematic" "beautiful"
   - If speakers exist, use `(S1)`, `(S2)` IDs and `<d>[Language] dialogue</d>`

2. `overall_soundscape`: 1-4 sentences. Ambient + physical sounds.

3. `non_diegetic_music`: 1-3 sentences. Audience-only BGM, or `N/A`.

**Hard rules:**
- Match total timeline to requested duration ({duration_s} seconds)
- DO NOT use placeholder text like "TBD" or "..."
- DO NOT add any preamble/explanation outside the 3 sections
- DO NOT invent reference labels (T2VA has NONE)
- Output ONLY the 3 sections, separated by blank lines
"""


# === 6 段/3 段结构化解析 ===
def _parse_structured_sections(content: str) -> dict[str, str]:
    """从 LLM 输出里抽取 6/3 段内容, 按段名索引。

    容错策略:
      1. 按行扫描, 找 `section_name:` 开头
      2. section 内容一直累积到下一个 `section_name:` 或 EOF
    """
    section_names = (
        "subject_definitions",
        "summary",
        "retention_analysis",
        "detailed_description",
        "integrated_multimodal_description",
        "overall_soundscape",
        "non_diegetic_music",
    )
    pattern = re.compile(
        r"^\s*(" + "|".join(section_names) + r")\s*:\s*(.*)$",
        re.IGNORECASE,
    )

    sections: dict[str, str] = {}
    current_name: Optional[str] = None
    current_lines: list[str] = []

    for raw_line in content.splitlines():
        m = pattern.match(raw_line)
        if m:
            # flush previous
            if current_name is not None:
                sections[current_name] = "\n".join(current_lines).strip()
            current_name = m.group(1).lower()
            first = m.group(2).strip()
            current_lines = [first] if first else []
        else:
            if current_name is not None:
                current_lines.append(raw_line)

    # flush last
    if current_name is not None:
        sections[current_name] = "\n".join(current_lines).strip()

    return sections


def _assemble_prompt(sections: dict[str, str], mode: str, max_chars: int = 4000) -> str:
    """按 mode 决定段顺序, 拼成最终 H3 prompt 全文。

    Ref2VA: 6 段固定顺序
    T2VA:   3 段固定顺序

    如果拼装后超过 max_chars, 截断 detailed_description (主段) 到能放下。
    其他段保持完整 —— 它们是结构性字段, 不能截。
    """
    if mode == "Ref2VA":
        order = [
            "subject_definitions",
            "summary",
            "retention_analysis",
            "detailed_description",
            "overall_soundscape",
            "non_diegetic_music",
        ]
    else:
        order = [
            "integrated_multimodal_description",
            "overall_soundscape",
            "non_diegetic_music",
        ]

    parts = []
    for name in order:
        body = sections.get(name, "").strip()
        if body:
            parts.append(f"{name}: {body}")
    full = "\n\n".join(parts)

    # === 截断逻辑: 超 max_chars 时压缩主段 ===
    if len(full) <= max_chars:
        return full

    # 算出"非主段" (subject_definitions, summary, retention_analysis, soundscape, music) 占多少
    main_name = "detailed_description" if mode == "Ref2VA" else "integrated_multimodal_description"
    non_main = "\n\n".join(
        f"{n}: {sections.get(n, '').strip()}"
        for n in order
        if n != main_name and sections.get(n, "").strip()
    )
    overhead = len(non_main) + 2 * (len(order) - 1)  # 段间空行
    main_budget = max_chars - overhead - len(f"{main_name}: ")

    main_body = sections.get(main_name, "").strip()
    if len(main_body) > main_budget:
        # 在最近一个句号处截断, 避免截到单词中间
        truncated = main_body[:main_budget]
        last_period = max(
            truncated.rfind(". "),
            truncated.rfind("。"),
        )
        if last_period > main_budget * 0.7:
            truncated = truncated[:last_period + 1]
        # 在 [Shot N] 边界截断更干净
        last_shot = truncated.rfind("[Shot ")
        if last_shot > main_budget * 0.7:
            truncated = truncated[:last_shot].rstrip()
        sections = dict(sections)  # 不改原 dict
        sections[main_name] = truncated

    # 重新拼装
    parts = []
    for name in order:
        body = sections.get(name, "").strip()
        if body:
            parts.append(f"{name}: {body}")
    return "\n\n".join(parts)


# === 文本扩写 ===
def _expand_with_llm(
    user_prompt: str,
    image_description: Optional[str],
    duration_s: int,
    mode: str,
) -> dict[str, str]:
    """调通用 LLM 文本扩写, 返回 {prompt, sections}。

    sections 是按段名索引的 dict (Ref2VA 6 段 / T2VA 3 段)。
    """
    if mode == "Ref2VA":
        system_prompt = _SYSTEM_PROMPT_REF2VA.format(duration_s=duration_s)
    else:
        system_prompt = _SYSTEM_PROMPT_T2VA.format(duration_s=duration_s)

    if image_description:
        user_content = (
            f"User's original request: {user_prompt}\n\n"
            f"Reference image description (from vision API):\n{image_description}\n\n"
            f"Target duration: {duration_s} seconds.\n\n"
            "Rewrite per the 6 sections (Ref2VA)."
        )
    else:
        user_content = (
            f"User's original request: {user_prompt}\n\n"
            f"Target duration: {duration_s} seconds.\n\n"
            "Rewrite per the 3 sections (T2VA)."
        )

    # ⚠️ 必须 ≥ 8000: 多数 LLM 的 thinking/CoT 会消耗 token, 太小只输出思考过程
    content = llm_client.chat_text(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        max_tokens=16000,
        timeout=240,
    )

    if not content:
        raise RuntimeError("LLM returned empty after stripping thinking")

    sections = _parse_structured_sections(content)
    final_prompt = _assemble_prompt(sections, mode)

    # 兜底: 如果解析不到任何段 (LLM 输出格式完全跑偏), 用原文
    if not final_prompt:
        final_prompt = content

    return {"prompt": final_prompt, "sections": sections}


# === 主入口 ===
def expand_prompt(
    user_prompt: str,
    duration_s: int = 5,
    ref_image_bytes: Optional[bytes] = None,
    ref_image_mime: str = "image/jpeg",
) -> dict:
    """扩写入口。

    Args:
        user_prompt: 用户原始 prompt 文本
        duration_s: 目标视频时长 (5/10/15)
        ref_image_bytes: 参考图二进制 (可选)
        ref_image_mime: 参考图 MIME (默认 image/jpeg)

    Returns:
        {
            "prompt": str,       # 最终 H3 prompt 全文, 写回 textarea
            "structured": {      # 折叠面板显示, 每个 key 对应一段
                "subject_definitions": "...",
                "summary": "...",
                "retention_analysis": "...",
                "detailed_description": "...",
                "overall_soundscape": "...",
                "non_diegetic_music": "...",
            },
            "mode": "Ref2VA" | "T2VA",
            "duration_s": 5,
            "image_description": str | None,  # vision 描述 (Ref2VA 才有)
            "vision_error": str | None,        # vision 失败信息 (降级时填)
        }
    """
    if not user_prompt or not user_prompt.strip():
        raise ValueError("user_prompt is empty")

    mode = "Ref2VA" if ref_image_bytes else "T2VA"
    image_description: Optional[str] = None
    vision_error: Optional[str] = None

    # Step 1: vision (如果 ref)
    if ref_image_bytes:
        try:
            image_description = describe_reference_image(ref_image_bytes, ref_image_mime)
        except Exception as e:
            vision_error = f"vision failed ({type(e).__name__}): {e}"
            # 降级: 跳过 image_description, 仍然按 Ref2VA 模式 (LLM 拿不到图描述也能扩)
            # 或者更激进: 降为 T2VA? 用户选择: 保持 Ref2VA, 但不带 image_description
            image_description = None

    # Step 2: 文本扩写
    expansion = _expand_with_llm(
        user_prompt=user_prompt,
        image_description=image_description,
        duration_s=duration_s,
        mode=mode,
    )

    return {
        "prompt": expansion["prompt"],
        "structured": expansion["sections"],
        "mode": mode,
        "duration_s": duration_s,
        "image_description": image_description,
        "vision_error": vision_error,
    }
