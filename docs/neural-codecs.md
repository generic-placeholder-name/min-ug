# Quantized neural codecs

The GRU-L and Transformer-L checkpoints can be lowered into independent, zero-import modules
implementing `codec-abi-v1`. GRU-L is frozen as public codec ID 1. Transformer-L remains an
unreleased experiment. Changing any weight, quantizer, probability conversion, compiler option, or
coder creates a different stream and therefore requires a new immutable codec ID.

## Build

```powershell
npm run codec:neural:build
```

The build performs the following steps:

1. Load the pinned PyTorch checkpoints.
2. Quantize every matrix symmetrically to signed int8 with one f32 scale per output row.
3. Store vectors, biases, LayerNorm parameters, and scales as f32.
4. Embed the resulting model binary in the Rust implementation.
5. Build separate GRU-L and Transformer-L modules with WebAssembly `simd128` enabled.
6. Reject the build unless the GRU-L candidate has v1's pinned SHA-256.

Weights are expanded to f32 once in module memory. The compressed WASM download therefore benefits
from int8 storage without claiming integer activation execution. Future int8 activation work should
be evaluated as a different codec artifact.

Both models predict the 91 bytes admitted by canonical HTTP(S) serialization plus an end-of-URL
symbol. The alphabet and its order are embedded in each model artifact; the Rust loader rejects a
model whose alphabet does not match the codec. Logits become a deterministic 12-bit frequency table
with a minimum frequency of one per symbol. The decoder runs the same model and frequency
construction one symbol at a time. GRU-L retains one recurrent state; Transformer-L retains
per-layer key/value caches for at most 512 input positions.

Codec ID 1 uses the 32-bit arithmetic coder. The pure-Rust `ans` crate remains wired behind the
`rans` Cargo feature for reproducible comparison builds, but its four-byte terminal state makes it
larger on these short independent messages.

The accepted domain is a canonical URL containing only that alphabet and shorter than 512 bytes.
The dispatcher must use literal fallback outside that domain.

## Benchmark

```powershell
npm run codec:neural:bench -- --urls 1000
```

To build and benchmark the arithmetic and rANS implementations against identical integer
frequency tables:

```powershell
npm run codec:neural:compare-build
npm run codec:neural:bench -- --compare-entropy-coders --urls 1000
```

The default experiment uses a seeded reservoir sample split equally between seen-host and
unseen-host validation URLs. It reports exact round trips, byte-aligned payload size, payload-only
ASCII-84 and QR-43 character counts, and warm V8 WebAssembly latency.

Candidate character estimates remain useful for comparing models. GRU-L additionally reports the
actual public v1 base-81 fragment and complete `min.ug#...` display length, including its two-bit
dispatch header. The permanent framing is specified in [`link-format-v1.md`](link-format-v1.md).

Benchmark reports are generated locally under the ignored `reports/` directory. On the recorded
1,000-URL selection run:

| Metric | GRU-L | Transformer-L |
|---|---:|---:|
| Exact round trips | 1,000 / 1,000 | 1,000 / 1,000 |
| Payload bits / URL | 193.52 | 199.72 |
| Mean ASCII-84 payload characters | 30.84 | 31.83 |
| Median ASCII-84 payload characters | 27 | 28 |
| Mean core encode latency | 16.66 ms | 12.72 ms |
| Mean core decode latency | 16.66 ms | 12.69 ms |
| WASM bytes | 347,180 | 339,361 |

GRU-L v1's actual base-81 fragment averages 31.28 characters. The complete forced-scheme display
form, `min.ug#<frame>`, averages 38.28 characters versus 73.11 for the original URL, a 47.64%
aggregate reduction. Full v1 encode and decode, including framing and base conversion, average
16.69 ms each on the benchmark machine.

On the same URLs, rANS averaged 27.12 GRU payload bytes versus arithmetic's 24.19, increasing the
complete link from 38.28 to 41.90 characters. Transformer showed the same result: 27.90 versus
24.97 payload bytes. All four variants reproduced 1,000/1,000 URLs exactly; their measured speed
was effectively tied relative to normal run-to-run variation.

GRU-L remains the compression winner. Transformer-L is faster in the current implementation because
its 96-wide projections require less dense work per byte than the GRU's 256-wide three-gate update.
The runtime is a correctness-first scalar implementation with compiler SIMD enabled; buffer reuse,
explicit vector kernels, and integer activations remain optimization work.
