"""Convert the Apache-2.0 Norovox Embed Zero fast encoder to llama.cpp Qwen2 GGUF."""

import argparse
import hashlib
import json
from pathlib import Path
import re

import gguf
import numpy as np
from safetensors import safe_open


def weight_names(source: str):
    """Return the equivalent Hugging Face Qwen2 name and its GGUF name."""
    if source == "embed.weight":
        return "model.embed_tokens.weight", "token_embd.weight"
    if source == "norm_f.w":
        return "model.norm.weight", "output_norm.weight"
    match = re.fullmatch(r"layers\.(\d+)\.(.+)", source)
    if not match:
        raise ValueError(f"Unmapped tensor: {source}")
    block, suffix = match.groups()
    names = {
        "norm1.w": ("input_layernorm.weight", "attn_norm.weight"),
        "norm2.w": ("post_attention_layernorm.weight", "ffn_norm.weight"),
        "ffn.gate.weight": ("mlp.gate_proj.weight", "ffn_gate.weight"),
        "ffn.up.weight": ("mlp.up_proj.weight", "ffn_up.weight"),
        "ffn.down.weight": ("mlp.down_proj.weight", "ffn_down.weight"),
    }
    for part, target in (("q", "q"), ("k", "k"), ("v", "v"), ("o", "output")):
        names[f"attn.{part}_proj.weight"] = (f"self_attn.{part}_proj.weight", f"attn_{target}.weight")
        if part != "o":
            names[f"attn.{part}_proj.bias"] = (f"self_attn.{part}_proj.bias", f"attn_{target}.bias")
    qwen, target = names[suffix]
    return f"model.layers.{block}.{qwen}", f"blk.{block}.{target}"


def tokenizer_metadata(writer, token_json: Path, size: int, pad: int):
    tokenizer = json.loads(token_json.read_text(encoding="utf-8"))
    if tokenizer["model"]["type"] != "BPE":
        raise ValueError("Expected Qwen2 byte-level BPE tokenizer")
    if tokenizer["normalizer"] != {"type": "NFC"}:
        raise ValueError("Expected NFC normalization for Cude's llama-server input")
    tokens = [f"[PAD{i}]" for i in range(size)]
    types = [gguf.TokenType.UNUSED] * size
    for token, index in tokenizer["model"]["vocab"].items():
        tokens[index], types[index] = token, gguf.TokenType.NORMAL
    for token in tokenizer["added_tokens"]:
        index = token["id"]
        tokens[index] = token["content"]
        types[index] = gguf.TokenType.CONTROL if token["special"] else gguf.TokenType.USER_DEFINED
    merges = tokenizer["model"]["merges"]
    writer.add_tokenizer_model("gpt2")
    writer.add_tokenizer_pre("qwen2")
    writer.add_token_list(tokens)
    writer.add_token_types(types)
    writer.add_token_merges([" ".join(pair) if isinstance(pair, list) else pair for pair in merges])
    writer.add_pad_token_id(pad)
    writer.add_eos_token_id(pad)
    writer.add_add_bos_token(False)
    writer.add_add_eos_token(False)


def convert(source: Path, output: Path, quantization: str):
    config = json.loads((source / "config.json").read_text(encoding="utf-8"))
    core = config["core"]
    if (core["d_model"], core["n_head"], core["n_kv_head"], core["qkv_bias"]) != (768, 12, 4, True):
        raise ValueError("Unexpected Norovox architecture")
    if (config["attention"], config["max_len"], config["prefixes"]) != (
        "bidirectional", 256, {"query": "query: ", "document": "passage: "}
    ):
        raise ValueError("Unexpected Norovox encoder contract")
    writer = gguf.GGUFWriter(output, "qwen2", use_temp_file=True)
    writer.add_name("Norovox Embed Zero")
    writer.add_author("Norovox Labs")
    writer.add_license("Apache-2.0")
    writer.add_source_url("https://huggingface.co/emrevrg/Norovox-Embed-Zero")
    writer.add_file_type(gguf.LlamaFileType.MOSTLY_F16 if quantization == "F16" else gguf.LlamaFileType.MOSTLY_Q8_0)
    writer.add_quantization_version(gguf.GGML_QUANT_VERSION)
    writer.add_context_length(config["max_len"])
    writer.add_embedding_length(core["d_model"])
    writer.add_block_count(core["n_layer"])
    writer.add_feed_forward_length(core["h_ffn"])
    writer.add_head_count(core["n_head"])
    writer.add_head_count_kv(core["n_kv_head"])
    writer.add_rope_dimension_count(core["head_dim"])
    writer.add_rope_freq_base(core["rope_theta"])
    writer.add_layer_norm_rms_eps(core["rms_eps"])
    writer.add_causal_attention(False)
    writer.add_pooling_type(gguf.PoolingType.MEAN)
    tokenizer_metadata(writer, source / "tokenizer.json", core["vocab_size"], config["pad_id"])
    with safe_open(source / "model.safetensors", framework="np") as weights:
        keys = weights.keys()
        if len(keys) != 2 + 12 * core["n_layer"]:
            raise ValueError("Unexpected number of encoder weights")
        for key in keys:
            _, name = weight_names(key)
            tensor = weights.get_tensor(key)
            if tensor.ndim == 1:
                writer.add_tensor(name, tensor.astype(np.float32, copy=False))
            elif quantization == "F16":
                writer.add_tensor(name, tensor.astype(np.float16))
            else:
                tensor_type = gguf.GGMLQuantizationType.Q8_0
                writer.add_tensor(name, gguf.quantize(tensor, tensor_type), raw_dtype=tensor_type)
    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()
    with output.open("rb") as stream:
        print(f"{output.name} {output.stat().st_size} {hashlib.file_digest(stream, 'sha256').hexdigest()}")


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("model_dir", type=Path)
    cli.add_argument("output", type=Path)
    cli.add_argument("--type", choices=("F16", "Q8_0"), required=True)
    args = cli.parse_args()
    convert(args.model_dir, args.output, args.type)
