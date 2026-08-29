import assert from "node:assert/strict";
import test from "node:test";

import {
  WasmCodecError,
  WasmCodecStatusError,
  createWasmCodecAdapter,
  instantiateWasmCodec
} from "../src/codec/wasm-adapter.js";
import type { CanonicalUrl } from "../src/canonicalize/index.js";

const encoder = new TextEncoder();

interface AllocateContext {
  readonly allocationCount: number;
  readonly allocateRaw: (length: number) => number;
  readonly length: number;
  readonly memory: WebAssembly.Memory;
}

interface FreeContext {
  readonly pointer: number;
  readonly length: number;
  readonly memory: WebAssembly.Memory;
}

interface OperationContext {
  readonly allocateRaw: (length: number) => number;
  readonly descriptorPointer: number;
  readonly identity: () => number;
  readonly inputLength: number;
  readonly inputPointer: number;
  readonly memory: WebAssembly.Memory;
  readonly writeDescriptor: (outputPointer: number, outputLength: number) => void;
}

interface FakeBehavior {
  readonly allocate?: (context: AllocateContext) => number;
  readonly free?: (context: FreeContext) => unknown;
  readonly encode?: (context: OperationContext) => unknown;
  readonly decode?: (context: OperationContext) => unknown;
}

interface FakeExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  minug_alloc: (length: number) => number;
  minug_free: (pointer: number, length: number) => unknown;
  minug_encode: (inputPointer: number, inputLength: number, descriptorPointer: number) => unknown;
  minug_decode: (inputPointer: number, inputLength: number, descriptorPointer: number) => unknown;
}

function canonical (value: string): CanonicalUrl {
  return value as CanonicalUrl;
}

function createFakeExports (behavior: FakeBehavior = {}) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 8 });
  const freeCalls: Array<[number, number]> = [];
  let nextPointer = 64;
  let allocationCount = 0;

  function allocateRaw (length: number): number {
    if (length === 0) return 0;
    const pointer = (nextPointer + 7) & ~7;
    const end = pointer + length;
    if (end > memory.buffer.byteLength) {
      memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
    }
    nextPointer = end;
    return pointer;
  }

  function writeDescriptor (
    descriptorPointer: number,
    outputPointer: number,
    outputLength: number
  ): void {
    const descriptor = new DataView(memory.buffer, descriptorPointer, 8);
    descriptor.setUint32(0, outputPointer, true);
    descriptor.setUint32(4, outputLength, true);
  }

  function identity (inputPointer: number, inputLength: number, descriptorPointer: number): number {
    const input = new Uint8Array(memory.buffer, inputPointer, inputLength).slice();
    const outputPointer = allocateRaw(inputLength);
    new Uint8Array(memory.buffer, outputPointer, inputLength).set(input);
    writeDescriptor(descriptorPointer, outputPointer, inputLength);
    return 0;
  }

  function minug_alloc (length: number): number {
    allocationCount += 1;
    if (behavior.allocate) {
      return behavior.allocate({
        allocationCount,
        allocateRaw,
        length,
        memory
      });
    }
    return allocateRaw(length);
  }

  function minug_free (pointer: number, length: number): unknown {
    freeCalls.push([pointer, length]);
    return behavior.free?.({ length, memory, pointer });
  }

  function operate (
    operation: "encode" | "decode",
    inputPointer: number,
    inputLength: number,
    descriptorPointer: number
  ): unknown {
    const context: OperationContext = {
      allocateRaw,
      descriptorPointer,
      identity: () => identity(inputPointer, inputLength, descriptorPointer),
      inputLength,
      inputPointer,
      memory,
      writeDescriptor: (outputPointer: number, outputLength: number) => {
        writeDescriptor(descriptorPointer, outputPointer, outputLength);
      }
    };
    return behavior[operation]
      ? behavior[operation](context)
      : context.identity();
  }

  function minug_encode (
    inputPointer: number,
    inputLength: number,
    descriptorPointer: number
  ): unknown {
    return operate("encode", inputPointer, inputLength, descriptorPointer);
  }

  function minug_decode (
    inputPointer: number,
    inputLength: number,
    descriptorPointer: number
  ): unknown {
    return operate("decode", inputPointer, inputLength, descriptorPointer);
  }

  return {
    exports: { memory, minug_alloc, minug_free, minug_encode, minug_decode } as FakeExports,
    freeCalls,
    memory
  };
}

function throwsCode (code: string): (error: unknown) => boolean {
  return error => error instanceof WasmCodecError && error.code === code;
}

test("decode snapshots a caller view before this module grows and detaches it", () => {
  let firstAllocation = true;
  const fake = createFakeExports({
    allocate ({ allocateRaw, length, memory }) {
      if (firstAllocation) {
        firstAllocation = false;
        memory.grow(1);
      }
      return allocateRaw(length);
    }
  });
  const payload = new Uint8Array(fake.memory.buffer, 0, 3);
  payload.set(encoder.encode("abc"));
  const codec = createWasmCodecAdapter(fake.exports);

  assert.equal(codec.decode(payload), "abc");
  assert.equal(payload.byteLength, 0, "memory.grow should detach the caller's original view");
});

test("adapter copies owned output and frees output, descriptor, then input", () => {
  const fake = createFakeExports();
  const codec = createWasmCodecAdapter(fake.exports);
  const canonicalUrl = "https://example.com/π?q=a%2Bb";
  const expected = encoder.encode(canonicalUrl);

  assert.deepEqual(codec.encode(canonical(canonicalUrl)), expected);
  assert.equal(fake.freeCalls.length, 3);
  assert.deepEqual(fake.freeCalls.map(([, length]) => length), [expected.length, 8, expected.length]);
  assert.notEqual(fake.freeCalls[0]![0], fake.freeCalls[2]![0], "output must not alias input");
});

test("declared codec errors clean up and leave the instance reusable", () => {
  let operationCount = 0;
  const fake = createFakeExports({
    encode (context) {
      operationCount += 1;
      return operationCount === 1 ? 2 : context.identity();
    }
  });
  const codec = createWasmCodecAdapter(fake.exports);

  assert.throws(
    () => codec.encode(canonical("https://example.com/first")),
    error => error instanceof WasmCodecStatusError &&
      error.operation === "encode" && error.status === 2
  );
  assert.deepEqual(fake.freeCalls.map(([, length]) => length), [8, 25]);

  assert.deepEqual(
    codec.encode(canonical("https://example.com/second")),
    encoder.encode("https://example.com/second")
  );
});

test("allocation failures free only allocations that were actually acquired", async t => {
  await t.test("first allocation", () => {
    const fake = createFakeExports({
      allocate ({ allocationCount, allocateRaw, length }) {
        return allocationCount === 1 ? 0 : allocateRaw(length);
      }
    });
    const codec = createWasmCodecAdapter(fake.exports);
    assert.throws(
      () => codec.encode(canonical("https://example.com/")),
      throwsCode("allocation-failed")
    );
    assert.deepEqual(fake.freeCalls, []);
    assert.deepEqual(codec.encode(canonical("ok")), encoder.encode("ok"));
  });

  await t.test("descriptor allocation", () => {
    const fake = createFakeExports({
      allocate ({ allocationCount, allocateRaw, length }) {
        return allocationCount === 2 ? 0 : allocateRaw(length);
      }
    });
    const codec = createWasmCodecAdapter(fake.exports);
    const input = "https://example.com/";
    assert.throws(() => codec.encode(canonical(input)), throwsCode("allocation-failed"));
    assert.deepEqual(fake.freeCalls.map(([, length]) => length), [encoder.encode(input).length]);
  });
});

test("host limits reject safely without poisoning a valid instance", () => {
  const fake = createFakeExports();
  const codec = createWasmCodecAdapter(fake.exports, {
    maxCanonicalUrlBytes: 5,
    maxPayloadBytes: 4
  });

  assert.throws(() => codec.encode(canonical("123456")), throwsCode("input-limit"));
  assert.deepEqual(fake.freeCalls, []);
  assert.throws(() => codec.encode(canonical("12345")), throwsCode("output-limit"));
  assert.equal(fake.freeCalls.length, 3);
  assert.deepEqual(codec.encode(canonical("1234")), encoder.encode("1234"));
});

test("invalid UTF-8 is detected after valid allocations are released, then poisons", () => {
  const fake = createFakeExports();
  const codec = createWasmCodecAdapter(fake.exports);

  assert.throws(() => codec.decode(Uint8Array.of(0xc3, 0x28)), throwsCode("invalid-utf8"));
  assert.equal(fake.freeCalls.length, 3);
  assert.throws(() => codec.decode(Uint8Array.of(0x61)), throwsCode("poisoned-instance"));
});

test("ABI violations poison the instance and skip unsafe cleanup", async t => {
  const cases: readonly {
    readonly name: string;
    readonly behavior: FakeBehavior;
    readonly code: string;
  }[] = [
    {
      name: "unknown status",
      behavior: { encode: () => 99 },
      code: "invalid-status"
    },
    {
      name: "non-i32 result",
      behavior: { encode: () => 0x80000000 },
      code: "invalid-result"
    },
    {
      name: "trap",
      behavior: { encode: () => { throw new Error("boom"); } },
      code: "codec-trap"
    },
    {
      name: "output aliases input",
      behavior: {
        encode (context) {
          context.writeDescriptor(context.inputPointer, context.inputLength);
          return 0;
        }
      },
      code: "aliased-output"
    },
    {
      name: "output is out of bounds",
      behavior: {
        encode (context) {
          context.writeDescriptor(context.memory.buffer.byteLength - 1, 2);
          return 0;
        }
      },
      code: "invalid-slice"
    },
    {
      name: "error status also returns output",
      behavior: {
        encode (context) {
          context.writeDescriptor(context.inputPointer, context.inputLength);
          return 2;
        }
      },
      code: "invalid-error-result"
    },
    {
      name: "empty output has a nonzero pointer",
      behavior: {
        encode (context) {
          context.writeDescriptor(context.inputPointer, 0);
          return 0;
        }
      },
      code: "invalid-slice"
    },
    {
      name: "output aliases descriptor",
      behavior: {
        encode (context) {
          context.writeDescriptor(context.descriptorPointer, 8);
          return 0;
        }
      },
      code: "aliased-output"
    }
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const fake = createFakeExports(entry.behavior);
      const codec = createWasmCodecAdapter(fake.exports);
      assert.throws(
        () => codec.encode(canonical("https://example.com/")),
        throwsCode(entry.code)
      );
      assert.deepEqual(fake.freeCalls, []);
      assert.throws(
        () => codec.encode(canonical("https://example.com/")),
        throwsCode("poisoned-instance")
      );
    });
  }

  await t.test("allocator overlap", () => {
    const fake = createFakeExports({ allocate: () => 64 });
    const codec = createWasmCodecAdapter(fake.exports);
    assert.throws(
      () => codec.encode(canonical("https://example.com/")),
      throwsCode("aliased-allocation")
    );
    assert.deepEqual(fake.freeCalls, []);
  });

  await t.test("allocator returns non-i32", () => {
    const fake = createFakeExports({ allocate: () => Number.NaN });
    const codec = createWasmCodecAdapter(fake.exports);
    assert.throws(
      () => codec.encode(canonical("https://example.com/")),
      throwsCode("invalid-result")
    );
    assert.deepEqual(fake.freeCalls, []);
  });

  await t.test("descriptor allocation is misaligned", () => {
    const fake = createFakeExports({
      allocate ({ allocationCount, allocateRaw, length }) {
        const pointer = allocateRaw(length + (allocationCount === 2 ? 1 : 0));
        return allocationCount === 2 ? pointer + 1 : pointer;
      }
    });
    const codec = createWasmCodecAdapter(fake.exports);
    assert.throws(
      () => codec.encode(canonical("https://example.com/")),
      throwsCode("invalid-alignment")
    );
    assert.deepEqual(fake.freeCalls, []);
  });
});

test("a trap while freeing poisons the instance and stops cleanup", () => {
  const fake = createFakeExports({ free: () => { throw new Error("free failed"); } });
  const codec = createWasmCodecAdapter(fake.exports);

  assert.throws(
    () => codec.encode(canonical("https://example.com/")),
    throwsCode("codec-trap")
  );
  assert.equal(fake.freeCalls.length, 1);
  assert.throws(
    () => codec.encode(canonical("https://example.com/")),
    throwsCode("poisoned-instance")
  );
});

test("memory limit is checked even when a codec returns an error or allocation failure", async t => {
  await t.test("operation error", () => {
    const fake = createFakeExports({
      encode ({ memory }) {
        memory.grow(1);
        return 2;
      }
    });
    const codec = createWasmCodecAdapter(fake.exports, { maxMemoryBytes: 65536 });
    assert.throws(
      () => codec.encode(canonical("https://example.com/")),
      throwsCode("memory-limit")
    );
    assert.deepEqual(fake.freeCalls, []);
  });

  await t.test("allocator failure", () => {
    const fake = createFakeExports({
      allocate ({ memory }) {
        memory.grow(1);
        return 0;
      }
    });
    const codec = createWasmCodecAdapter(fake.exports, { maxMemoryBytes: 65536 });
    assert.throws(
      () => codec.encode(canonical("https://example.com/")),
      throwsCode("memory-limit")
    );
    assert.deepEqual(fake.freeCalls, []);
  });

  await t.test("free", () => {
    const fake = createFakeExports({ free: ({ memory }) => memory.grow(1) });
    const codec = createWasmCodecAdapter(fake.exports, { maxMemoryBytes: 65536 });
    assert.throws(
      () => codec.encode(canonical("https://example.com/")),
      throwsCode("memory-limit")
    );
    assert.equal(fake.freeCalls.length, 1);
  });
});

test("module loader rejects ambient imports", async () => {
  const moduleWithImport = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x02, 0x07, 0x01, 0x01, 0x78, 0x01, 0x79, 0x00, 0x00
  ]);
  await assert.rejects(
    instantiateWasmCodec(moduleWithImport),
    throwsCode("forbidden-imports")
  );
});

test("module and adapter validation reject malformed boundaries", async t => {
  await t.test("invalid WebAssembly bytes", async () => {
    await assert.rejects(
      instantiateWasmCodec(Uint8Array.of(0x00)),
      throwsCode("invalid-module")
    );
  });

  await t.test("missing required exports", async () => {
    const emptyModule = Uint8Array.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00
    ]);
    await assert.rejects(
      instantiateWasmCodec(emptyModule),
      throwsCode("invalid-exports")
    );
  });

  await t.test("initial memory exceeds host policy", () => {
    const fake = createFakeExports();
    fake.exports.memory = new WebAssembly.Memory({ initial: 2 });
    assert.throws(
      () => createWasmCodecAdapter(fake.exports, { maxMemoryBytes: 65536 }),
      throwsCode("memory-limit")
    );
  });

  await t.test("shared memory", () => {
    const fake = createFakeExports();
    fake.exports.memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    assert.throws(() => createWasmCodecAdapter(fake.exports), throwsCode("invalid-memory"));
  });

  await t.test("wrong function arity", () => {
    const fake = createFakeExports();
    fake.exports.minug_alloc = function minug_alloc () { return 64; };
    assert.throws(() => createWasmCodecAdapter(fake.exports), throwsCode("invalid-exports"));
  });

  await t.test("invalid configured limit", () => {
    const fake = createFakeExports();
    assert.throws(
      () => createWasmCodecAdapter(fake.exports, { maxPayloadBytes: 0 }),
      throwsCode("invalid-limit")
    );
  });
});
