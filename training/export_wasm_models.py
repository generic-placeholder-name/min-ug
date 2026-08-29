from __future__ import annotations

import argparse
import hashlib
import json
import struct
from pathlib import Path
from typing import Any

import numpy as np
import torch

from .byte_models import URL_BYTE_ALPHABET, VOCABULARY_SIZE


class ArtifactWriter:
    def __init__(self, header: bytes) -> None:
        if len(header) != 8:
            raise ValueError("model artifact headers must be eight bytes")
        self.data = bytearray(header + URL_BYTE_ALPHABET)
        self.quantization: list[dict[str, float | int | str]] = []

    def vector(self, tensor: torch.Tensor, expected: int, name: str) -> None:
        value = tensor.detach().to(dtype=torch.float32, device="cpu").contiguous()
        if value.shape != (expected,):
            raise ValueError(f"{name} has shape {tuple(value.shape)}, expected {(expected,)}")
        self.data.extend(value.numpy().astype("<f4", copy=False).tobytes())

    def matrix(
        self,
        tensor: torch.Tensor,
        rows: int,
        columns: int,
        name: str,
    ) -> None:
        value = tensor.detach().to(dtype=torch.float32, device="cpu").contiguous()
        if value.shape != (rows, columns):
            raise ValueError(
                f"{name} has shape {tuple(value.shape)}, expected {(rows, columns)}"
            )
        maximum = value.abs().amax(dim=1)
        scales = torch.where(maximum == 0, torch.ones_like(maximum), maximum / 127.0)
        quantized = torch.clamp(torch.round(value / scales[:, None]), -127, 127).to(torch.int8)
        restored = quantized.float() * scales[:, None]
        error = (restored - value).abs()
        self.data.extend(scales.numpy().astype("<f4", copy=False).tobytes())
        self.data.extend(quantized.numpy().astype(np.int8, copy=False).tobytes())
        self.quantization.append(
            {
                "name": name,
                "rows": rows,
                "columns": columns,
                "maximumAbsoluteError": float(error.max().item()),
                "meanAbsoluteError": float(error.mean().item()),
            }
        )

    def write(self, path: Path) -> dict[str, Any]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.data)
        digest = hashlib.sha256(self.data).hexdigest()
        return {
            "path": str(path),
            "bytes": len(self.data),
            "sha256": digest,
            "quantization": self.quantization,
        }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def load_checkpoint(path: Path) -> dict[str, torch.Tensor]:
    state = torch.load(path, map_location="cpu", weights_only=True)
    if not isinstance(state, dict) or not all(isinstance(value, torch.Tensor) for value in state.values()):
        raise ValueError(f"{path} is not a tensor state dictionary")
    return state


def export_gru(path: Path, output: Path) -> dict[str, Any]:
    state = load_checkpoint(path)
    writer = ArtifactWriter(b"MINUG2GR")
    writer.matrix(state["embedding.weight"], VOCABULARY_SIZE, 96, "embedding.weight")
    writer.matrix(state["recurrent.weight_ih_l0"], 768, 96, "recurrent.weight_ih_l0")
    writer.matrix(state["recurrent.weight_hh_l0"], 768, 256, "recurrent.weight_hh_l0")
    writer.vector(state["recurrent.bias_ih_l0"], 768, "recurrent.bias_ih_l0")
    writer.vector(state["recurrent.bias_hh_l0"], 768, "recurrent.bias_hh_l0")
    writer.matrix(state["projection.weight"], 96, 256, "projection.weight")
    writer.vector(state["normalization.weight"], 96, "normalization.weight")
    writer.vector(state["normalization.bias"], 96, "normalization.bias")
    writer.vector(state["output_bias"], VOCABULARY_SIZE, "output_bias")
    result = writer.write(output)
    result["checkpoint"] = {"path": str(path), "sha256": sha256_file(path)}
    result["architecture"] = {"embedding": 96, "hidden": 256, "layers": 1}
    return result


def export_transformer(path: Path, output: Path) -> dict[str, Any]:
    state = load_checkpoint(path)
    writer = ArtifactWriter(b"MINUG2TR")
    writer.matrix(state["embedding.weight"], VOCABULARY_SIZE, 96, "embedding.weight")
    writer.matrix(state["position.weight"], 512, 96, "position.weight")
    for layer in range(3):
        prefix = f"encoder.layers.{layer}"
        writer.matrix(state[f"{prefix}.self_attn.in_proj_weight"], 288, 96, f"{prefix}.self_attn.in_proj_weight")
        writer.vector(state[f"{prefix}.self_attn.in_proj_bias"], 288, f"{prefix}.self_attn.in_proj_bias")
        writer.matrix(state[f"{prefix}.self_attn.out_proj.weight"], 96, 96, f"{prefix}.self_attn.out_proj.weight")
        writer.vector(state[f"{prefix}.self_attn.out_proj.bias"], 96, f"{prefix}.self_attn.out_proj.bias")
        writer.matrix(state[f"{prefix}.linear1.weight"], 192, 96, f"{prefix}.linear1.weight")
        writer.vector(state[f"{prefix}.linear1.bias"], 192, f"{prefix}.linear1.bias")
        writer.matrix(state[f"{prefix}.linear2.weight"], 96, 192, f"{prefix}.linear2.weight")
        writer.vector(state[f"{prefix}.linear2.bias"], 96, f"{prefix}.linear2.bias")
        writer.vector(state[f"{prefix}.norm1.weight"], 96, f"{prefix}.norm1.weight")
        writer.vector(state[f"{prefix}.norm1.bias"], 96, f"{prefix}.norm1.bias")
        writer.vector(state[f"{prefix}.norm2.weight"], 96, f"{prefix}.norm2.weight")
        writer.vector(state[f"{prefix}.norm2.bias"], 96, f"{prefix}.norm2.bias")
    writer.vector(state["normalization.weight"], 96, "normalization.weight")
    writer.vector(state["normalization.bias"], 96, "normalization.bias")
    writer.vector(state["output.bias"], VOCABULARY_SIZE, "output.bias")
    result = writer.write(output)
    result["checkpoint"] = {"path": str(path), "sha256": sha256_file(path)}
    result["architecture"] = {
        "dimension": 96,
        "heads": 6,
        "layers": 3,
        "feedforward": 192,
        "maximumLength": 512,
    }
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Export weight-only int8 WASM model artifacts")
    parser.add_argument(
        "--gru-checkpoint",
        type=Path,
        default=Path("data/training/model-compact-full/gru-l.pt"),
    )
    parser.add_argument(
        "--transformer-checkpoint",
        type=Path,
        default=Path("data/training/model-compact-full/transformer-l.pt"),
    )
    parser.add_argument(
        "--output-directory",
        type=Path,
        default=Path("codecs/neural-codec/models"),
    )
    args = parser.parse_args()
    report = {
        "schemaVersion": 2,
        "format": "minug-weight-only-int8-v2",
        "alphabet": URL_BYTE_ALPHABET.decode("ascii"),
        "symbolCount": VOCABULARY_SIZE,
        "scales": "symmetric-f32-per-output-row",
        "models": {
            "gru-l": export_gru(args.gru_checkpoint, args.output_directory / "gru-l.bin"),
            "transformer-l": export_transformer(
                args.transformer_checkpoint,
                args.output_directory / "transformer-l.bin",
            ),
        },
    }
    manifest = args.output_directory / "manifest.json"
    manifest.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
