import { parentPort } from "node:worker_threads";

import {
  canonicalizeBatch,
  type CanonicalizationInput
} from "./canonicalize-batch.js";

if (parentPort === null) throw new Error("Canonicalization worker has no parent port");

parentPort.on("message", (message: { id: number; inputs: readonly CanonicalizationInput[] }) => {
  parentPort!.postMessage({ id: message.id, result: canonicalizeBatch(message.inputs) });
});
