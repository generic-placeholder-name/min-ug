from __future__ import annotations

import math
from dataclasses import dataclass

import torch
from torch import nn
from torch.nn import functional as F

URL_BYTE_ALPHABET = (
    b"!#$%&'()*+,-./0123456789:;=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`"
    b"abcdefghijklmnopqrstuvwxyz{|}~"
)
URL_BYTE_TO_TOKEN = tuple(
    URL_BYTE_ALPHABET.find(bytes((value,))) for value in range(256)
)
DELIMITER_TOKEN = len(URL_BYTE_ALPHABET)
VOCABULARY_SIZE = DELIMITER_TOKEN + 1
IGNORE_INDEX = -100

assert len(URL_BYTE_ALPHABET) == 91
assert len(set(URL_BYTE_ALPHABET)) == len(URL_BYTE_ALPHABET)


@dataclass(frozen=True)
class ByteTokenBatch:
    inputs: torch.Tensor
    targets: torch.Tensor
    valid: torch.Tensor

    @property
    def urls(self) -> int:
        return int(self.inputs.shape[0])

    @property
    def tokens(self) -> int:
        return int(self.valid.sum().item())


def tokenize_urls(
    urls: torch.Tensor,
    lengths: torch.Tensor,
    *,
    maximum_length: int,
) -> tuple[ByteTokenBatch | None, int]:
    """Turn canonical URL bytes into causal next-symbol examples.

    The delimiter is both the initial context and the end-of-URL target. URLs beyond the
    candidate codec's declared limit are counted for literal fallback instead of truncated.
    """

    if urls.ndim != 2 or lengths.ndim != 1 or urls.shape[0] != lengths.shape[0]:
        raise ValueError("urls and lengths have incompatible shapes")
    keep = lengths < maximum_length
    excluded = int((~keep).sum().item())
    if not bool(keep.any()):
        return None, excluded
    urls = urls[keep].to(dtype=torch.long)
    lengths = lengths[keep].to(dtype=torch.long)
    width = int(lengths.max().item())
    positions = torch.arange(width, device=urls.device).unsqueeze(0)
    byte_valid = positions < lengths.unsqueeze(1)
    byte_to_token = torch.tensor(URL_BYTE_TO_TOKEN, dtype=torch.long, device=urls.device)
    url_tokens = byte_to_token[urls]
    if bool((url_tokens[:, :width][byte_valid] < 0).any()):
        invalid = int(urls[:, :width][byte_valid][url_tokens[:, :width][byte_valid] < 0][0])
        raise ValueError(f"canonical URL contains unsupported raw byte 0x{invalid:02x}")

    inputs = torch.full(
        (urls.shape[0], width + 1),
        DELIMITER_TOKEN,
        dtype=torch.long,
        device=urls.device,
    )
    targets = torch.full_like(inputs, IGNORE_INDEX)
    inputs[:, 1:][byte_valid] = url_tokens[:, :width][byte_valid]
    targets[:, :width][byte_valid] = url_tokens[:, :width][byte_valid]
    targets.scatter_(1, lengths.unsqueeze(1), DELIMITER_TOKEN)
    return ByteTokenBatch(inputs=inputs, targets=targets, valid=targets != IGNORE_INDEX), excluded


def sequence_bits(logits: torch.Tensor, batch: ByteTokenBatch) -> torch.Tensor:
    losses = F.cross_entropy(
        logits.transpose(1, 2),
        batch.targets,
        ignore_index=IGNORE_INDEX,
        reduction="none",
    )
    return (losses / math.log(2)).sum(dim=1)


class ByteMLP(nn.Module):
    def __init__(
        self,
        *,
        context: int = 8,
        embedding: int = 16,
        hidden: int = 96,
    ) -> None:
        super().__init__()
        if context < 1:
            raise ValueError("context must be positive")
        self.context = context
        self.embedding = nn.Embedding(VOCABULARY_SIZE, embedding)
        self.hidden = nn.Linear(context * embedding, hidden)
        self.output = nn.Linear(hidden, VOCABULARY_SIZE)

    def forward(self, inputs: torch.Tensor, valid: torch.Tensor | None = None) -> torch.Tensor:
        del valid
        padded = F.pad(inputs, (self.context - 1, 0), value=DELIMITER_TOKEN)
        contexts = padded.unfold(1, self.context, 1)
        embedded = self.embedding(contexts).flatten(start_dim=2)
        return self.output(F.relu(self.hidden(embedded)))


class ByteGRU(nn.Module):
    def __init__(
        self,
        *,
        embedding: int = 48,
        hidden: int = 128,
        layers: int = 1,
    ) -> None:
        super().__init__()
        self.embedding = nn.Embedding(VOCABULARY_SIZE, embedding)
        self.recurrent = nn.GRU(
            input_size=embedding,
            hidden_size=hidden,
            num_layers=layers,
            batch_first=True,
        )
        self.projection = nn.Linear(hidden, embedding, bias=False)
        self.normalization = nn.LayerNorm(embedding)
        self.output_bias = nn.Parameter(torch.zeros(VOCABULARY_SIZE))
        nn.init.normal_(self.embedding.weight, mean=0.0, std=embedding ** -0.5)

    def forward(self, inputs: torch.Tensor, valid: torch.Tensor | None = None) -> torch.Tensor:
        del valid
        hidden, _ = self.recurrent(self.embedding(inputs))
        projected = self.normalization(self.projection(hidden))
        return F.linear(projected, self.embedding.weight, self.output_bias)


class ByteLSTM(nn.Module):
    def __init__(
        self,
        *,
        embedding: int = 72,
        hidden: int = 216,
        layers: int = 1,
    ) -> None:
        super().__init__()
        self.embedding = nn.Embedding(VOCABULARY_SIZE, embedding)
        self.recurrent = nn.LSTM(
            input_size=embedding,
            hidden_size=hidden,
            num_layers=layers,
            batch_first=True,
        )
        self.projection = nn.Linear(hidden, embedding, bias=False)
        self.normalization = nn.LayerNorm(embedding)
        self.output_bias = nn.Parameter(torch.zeros(VOCABULARY_SIZE))
        nn.init.normal_(self.embedding.weight, mean=0.0, std=embedding ** -0.5)

    def forward(self, inputs: torch.Tensor, valid: torch.Tensor | None = None) -> torch.Tensor:
        del valid
        hidden, _ = self.recurrent(self.embedding(inputs))
        projected = self.normalization(self.projection(hidden))
        return F.linear(projected, self.embedding.weight, self.output_bias)


class ByteGRULocal(nn.Module):
    """A recurrent URL summary with an exact short-range byte path."""

    def __init__(
        self,
        *,
        context: int = 8,
        embedding: int = 64,
        hidden: int = 192,
        local_hidden: int = 192,
    ) -> None:
        super().__init__()
        if context < 1:
            raise ValueError("context must be positive")
        self.context = context
        self.embedding = nn.Embedding(VOCABULARY_SIZE, embedding)
        self.recurrent = nn.GRU(
            input_size=embedding,
            hidden_size=hidden,
            num_layers=1,
            batch_first=True,
        )
        self.recurrent_projection = nn.Linear(hidden, embedding, bias=False)
        self.local_hidden = nn.Linear(context * embedding, local_hidden)
        self.local_projection = nn.Linear(local_hidden, embedding, bias=False)
        self.normalization = nn.LayerNorm(embedding)
        self.output_bias = nn.Parameter(torch.zeros(VOCABULARY_SIZE))
        nn.init.normal_(self.embedding.weight, mean=0.0, std=embedding ** -0.5)

    def forward(self, inputs: torch.Tensor, valid: torch.Tensor | None = None) -> torch.Tensor:
        del valid
        embedded = self.embedding(inputs)
        recurrent, _ = self.recurrent(embedded)

        padded = F.pad(inputs, (self.context - 1, 0), value=DELIMITER_TOKEN)
        contexts = padded.unfold(1, self.context, 1)
        local = self.embedding(contexts).flatten(start_dim=2)
        local = self.local_projection(F.gelu(self.local_hidden(local)))

        projected = self.recurrent_projection(recurrent) + local
        projected = self.normalization(projected)
        return F.linear(projected, self.embedding.weight, self.output_bias)


class ByteSLSTM(nn.Module):
    """The stabilized exponential-gate sLSTM recurrence from the xLSTM paper.

    This intentionally isolates the recurrent cell from xLSTM's larger residual-block
    architecture. It lets us compare the memory mechanism at the same artifact budget as
    the GRU and LSTM candidates, and maps directly to a future byte-at-a-time codec.
    """

    def __init__(
        self,
        *,
        embedding: int = 72,
        hidden: int = 216,
    ) -> None:
        super().__init__()
        self.hidden = hidden
        self.embedding = nn.Embedding(VOCABULARY_SIZE, embedding)
        self.input_projection = nn.Linear(embedding, 4 * hidden, bias=False)
        self.recurrent_projection = nn.Linear(hidden, 4 * hidden, bias=False)
        self.gate_bias = nn.Parameter(torch.zeros(4 * hidden))
        self.output_projection = nn.Linear(hidden, embedding, bias=False)
        self.normalization = nn.LayerNorm(embedding)
        self.output_bias = nn.Parameter(torch.zeros(VOCABULARY_SIZE))

        nn.init.normal_(self.embedding.weight, mean=0.0, std=embedding ** -0.5)
        nn.init.orthogonal_(self.recurrent_projection.weight)
        with torch.no_grad():
            # Remembering early context is a useful initial bias for host and scheme bytes.
            self.gate_bias[hidden : 2 * hidden].fill_(3.0)

    def forward(self, inputs: torch.Tensor, valid: torch.Tensor | None = None) -> torch.Tensor:
        del valid
        projected_inputs = self.input_projection(self.embedding(inputs))
        batch = inputs.shape[0]
        dtype = projected_inputs.dtype
        device = projected_inputs.device
        hidden = torch.zeros((batch, self.hidden), dtype=dtype, device=device)
        cell = torch.zeros_like(hidden)
        normalizer = torch.zeros_like(hidden)
        stabilizer = torch.zeros_like(hidden)
        outputs: list[torch.Tensor] = []

        for index in range(inputs.shape[1]):
            raw = (
                projected_inputs[:, index]
                + self.recurrent_projection(hidden)
                + self.gate_bias
            )
            input_raw, forget_raw, cell_raw, output_raw = raw.chunk(4, dim=-1)
            log_forget = stabilizer + F.logsigmoid(forget_raw)
            new_stabilizer = (
                input_raw if index == 0 else torch.maximum(input_raw, log_forget)
            )
            input_gate = torch.exp(input_raw - new_stabilizer).clamp_max(1.0)
            forget_gate = torch.exp(log_forget - new_stabilizer).clamp_max(1.0)
            cell = forget_gate * cell + input_gate * torch.tanh(cell_raw)
            normalizer = forget_gate * normalizer + input_gate
            hidden = torch.sigmoid(output_raw) * cell / normalizer.clamp_min(1e-6)
            stabilizer = new_stabilizer
            outputs.append(hidden)

        sequence = torch.stack(outputs, dim=1)
        projected = self.normalization(self.output_projection(sequence))
        return F.linear(projected, self.embedding.weight, self.output_bias)


class ByteTransformer(nn.Module):
    def __init__(
        self,
        *,
        dimension: int,
        heads: int,
        layers: int,
        feedforward: int,
        maximum_length: int,
    ) -> None:
        super().__init__()
        self.maximum_length = maximum_length
        self.embedding = nn.Embedding(VOCABULARY_SIZE, dimension)
        self.position = nn.Embedding(maximum_length, dimension)
        layer = nn.TransformerEncoderLayer(
            d_model=dimension,
            nhead=heads,
            dim_feedforward=feedforward,
            dropout=0.0,
            activation="relu",
            batch_first=True,
            norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(
            layer,
            num_layers=layers,
            enable_nested_tensor=False,
        )
        self.normalization = nn.LayerNorm(dimension)
        self.output = nn.Linear(dimension, VOCABULARY_SIZE, bias=True)
        self.output.weight = self.embedding.weight
        nn.init.normal_(self.embedding.weight, mean=0.0, std=dimension ** -0.5)
        nn.init.normal_(self.position.weight, mean=0.0, std=dimension ** -0.5)
        nn.init.zeros_(self.output.bias)

    def forward(self, inputs: torch.Tensor, valid: torch.Tensor | None = None) -> torch.Tensor:
        length = inputs.shape[1]
        if length > self.maximum_length:
            raise ValueError(
                f"sequence length {length} exceeds transformer limit {self.maximum_length}"
            )
        positions = torch.arange(length, device=inputs.device)
        hidden = self.embedding(inputs) + self.position(positions).unsqueeze(0)
        causal_mask = torch.triu(
            torch.ones((length, length), dtype=torch.bool, device=inputs.device),
            diagonal=1,
        )
        hidden = self.encoder(
            hidden,
            mask=causal_mask,
            src_key_padding_mask=None if valid is None else ~valid,
        )
        return self.output(self.normalization(hidden))


def parameter_sizes(model: nn.Module) -> dict[str, int]:
    parameters = list(model.parameters())
    return {
        "parameters": sum(parameter.numel() for parameter in parameters),
        "float32Bytes": sum(parameter.numel() * parameter.element_size() for parameter in parameters),
        "estimatedInt8Bytes": sum(
            parameter.numel() if parameter.ndim > 1 else parameter.numel() * 4
            for parameter in parameters
        ),
    }


class ByteUnigram:
    def __init__(self, *, smoothing: float = 0.5, device: torch.device) -> None:
        self.smoothing = smoothing
        self.counts = torch.zeros(VOCABULARY_SIZE, dtype=torch.float64, device=device)

    def update(self, batch: ByteTokenBatch) -> None:
        targets = batch.targets[batch.valid]
        self.counts += torch.bincount(targets, minlength=VOCABULARY_SIZE)

    def probabilities(self) -> torch.Tensor:
        counts = self.counts + self.smoothing
        return counts / counts.sum()

    def bits(self, batch: ByteTokenBatch) -> torch.Tensor:
        probabilities = self.probabilities().to(dtype=torch.float32)
        losses = torch.zeros_like(batch.targets, dtype=torch.float32)
        losses[batch.valid] = -torch.log2(probabilities[batch.targets[batch.valid]])
        return losses.sum(dim=1)

    def artifact_bytes(self) -> int:
        return VOCABULARY_SIZE * 2


class HashedByteNGram:
    """Interpolated byte n-gram baseline with bounded dense hash tables.

    The fixed table sizes make the comparison repeatable and keep fitting the 10M-URL corpus
    bounded. This is an evaluation control, not the proposed shipped representation.
    """

    def __init__(
        self,
        *,
        order: int = 4,
        buckets: tuple[int, ...] = (257, 16384, 32768, 65536),
        smoothing: float = 0.5,
        backoff_strength: float = 8.0,
        device: torch.device,
    ) -> None:
        if order < 1 or order > len(buckets):
            raise ValueError("unsupported n-gram order")
        self.order = order
        self.bucket_counts = buckets[:order]
        self.smoothing = smoothing
        self.backoff_strength = backoff_strength
        self.unigrams = torch.zeros(VOCABULARY_SIZE, dtype=torch.float32, device=device)
        self.counts = [
            torch.zeros(bucket_count * VOCABULARY_SIZE, dtype=torch.float32, device=device)
            for bucket_count in self.bucket_counts
        ]
        self.totals = [
            torch.zeros(bucket_count, dtype=torch.float32, device=device)
            for bucket_count in self.bucket_counts
        ]

    @staticmethod
    def _contexts(inputs: torch.Tensor, order: int, buckets: int) -> torch.Tensor:
        padded = F.pad(inputs, (order - 1, 0), value=DELIMITER_TOKEN)
        windows = padded.unfold(1, order, 1)
        hashed = torch.zeros(windows.shape[:-1], dtype=torch.long, device=inputs.device)
        for index in range(order):
            hashed = (hashed * VOCABULARY_SIZE + windows[..., index]) % buckets
        return hashed

    def update(self, batch: ByteTokenBatch) -> None:
        targets = batch.targets[batch.valid]
        ones = torch.ones_like(targets, dtype=torch.float32)
        self.unigrams.scatter_add_(0, targets, ones)
        for order, (bucket_count, counts, totals) in enumerate(
            zip(self.bucket_counts, self.counts, self.totals),
            start=1,
        ):
            contexts = self._contexts(batch.inputs, order, bucket_count)[batch.valid]
            counts.scatter_add_(0, contexts * VOCABULARY_SIZE + targets, ones)
            totals.scatter_add_(0, contexts, ones)

    def bits(self, batch: ByteTokenBatch) -> torch.Tensor:
        targets = batch.targets[batch.valid]
        base = self.unigrams + self.smoothing
        probability = base[targets] / base.sum()
        for order, (bucket_count, counts, totals) in enumerate(
            zip(self.bucket_counts, self.counts, self.totals),
            start=1,
        ):
            contexts = self._contexts(batch.inputs, order, bucket_count)[batch.valid]
            observed = counts[contexts * VOCABULARY_SIZE + targets]
            probability = (
                observed + self.backoff_strength * probability
            ) / (totals[contexts] + self.backoff_strength)
        losses = torch.zeros_like(batch.targets, dtype=torch.float32)
        losses[batch.valid] = -torch.log2(probability)
        return losses.sum(dim=1)

    def working_set_bytes(self) -> int:
        tensors = [self.unigrams, *self.counts, *self.totals]
        return sum(tensor.numel() * tensor.element_size() for tensor in tensors)
