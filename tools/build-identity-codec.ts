import { spawn } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const toolsDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = join(
  dirname(toolsDirectory),
  "test",
  "fixtures",
  "identity-codec"
);
const artifactPath = join(
  fixtureDirectory,
  "target",
  "wasm32-unknown-unknown",
  "release",
  "minug_identity_codec.wasm"
);
const fixturePath = join(fixtureDirectory, "identity.wasm");

await new Promise<void>((resolve, reject) => {
  const cargo = spawn(
    "cargo",
    ["build", "--release", "--target", "wasm32-unknown-unknown"],
    { cwd: fixtureDirectory, stdio: "inherit", windowsHide: true }
  );
  cargo.once("error", reject);
  cargo.once("exit", code => {
    if (code === 0) resolve();
    else reject(new Error(`cargo exited with status ${code}`));
  });
});

await copyFile(artifactPath, fixturePath);
console.log(`Updated ${fixturePath}`);
