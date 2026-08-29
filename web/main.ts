import {
  canonicalize,
  CanonicalizationError,
  type CanonicalizationChange,
  type CanonicalizationPreset,
  type CanonicalizationResult,
  type CanonicalizationWarning
} from "../src/canonicalize/index.js";
import {
  DISPLAY_LINK_PREFIX,
  instantiateV1Codec,
  NAVIGATION_LINK_PREFIX,
  type VersionedFragmentCodec
} from "../src/codec/index.js";
import wasmUrl from "../codecs/artifacts/gru-l.wasm?url";
import "./styles.css";

type QrModule = typeof import("lean-qr");
type QrCode = ReturnType<QrModule["generate"]>;

interface CompressedResult {
  readonly displayLink: string;
  readonly fragment: string;
  readonly navigationLink: string;
}

function required<T extends Element> (selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing required element ${selector}`);
  return value;
}

const compressorView = required<HTMLElement>("#compressor-view");
const redirectView = required<HTMLElement>("#redirect-view");
const themeToggle = required<HTMLButtonElement>("#theme-toggle");
const themeMoon = required<SVGElement>("#theme-icon-moon");
const themeSun = required<SVGElement>("#theme-icon-sun");
const form = required<HTMLFormElement>("#compressor-form");
const input = required<HTMLInputElement>("#input-link");
const inputMessage = required<HTMLElement>("#input-message");
const riskConfirmation = required<HTMLElement>("#risk-confirmation");
const riskMessage = required<HTMLElement>("#risk-message");
const confirmRisk = required<HTMLButtonElement>("#confirm-risk");
const canonicalizationPreset = required<HTMLSelectElement>("#canonicalization-preset");
const canonicalizationHelp = required<HTMLElement>("#canonicalization-help");
const resultPanel = required<HTMLElement>("#result");
const outputLink = required<HTMLAnchorElement>("#output-link");
const resultDetail = required<HTMLElement>("#result-detail");
const cleanupWarning = required<HTMLElement>("#cleanup-warning");
const cleanupDetails = required<HTMLDetailsElement>("#cleanup-details");
const cleanupSummary = required<HTMLElement>("#cleanup-summary");
const cleanupList = required<HTMLUListElement>("#cleanup-list");
const copyButton = required<HTMLButtonElement>("#copy-link");
const showQr = required<HTMLInputElement>("#show-qr");
const qrPanel = required<HTMLElement>("#qr-panel");
const qrCanvas = required<HTMLCanvasElement>("#qr-code");
const qrCorrection = required<HTMLInputElement>("#qr-correction");
const qrCorrectionLabel = required<HTMLOutputElement>("#qr-correction-label");
const qrStatus = required<HTMLElement>("#qr-status");
const saveQr = required<HTMLButtonElement>("#save-qr");
const redirectLink = required<HTMLAnchorElement>("#redirect-link");
const continueLink = required<HTMLButtonElement>("#continue-link");
const backHome = required<HTMLButtonElement>("#back-home");

const localHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

let codec: VersionedFragmentCodec | undefined;
let currentResult: CompressedResult | undefined;
let currentQr: QrCode | undefined;
let qrModulePromise: Promise<QrModule> | undefined;
let updateTimer: number | undefined;
let renderGeneration = 0;
let confirmedRiskInput: string | undefined;

const qrCorrectionLabels = ["Low", "Medium", "Quartile", "High"] as const;
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

function effectiveTheme (): "light" | "dark" {
  const override = document.documentElement.dataset.theme;
  if (override === "light" || override === "dark") return override;
  return systemTheme.matches ? "dark" : "light";
}

function updateThemeControl (): void {
  const nextTheme = effectiveTheme() === "dark" ? "light" : "dark";
  themeMoon.toggleAttribute("hidden", nextTheme !== "dark");
  themeSun.toggleAttribute("hidden", nextTheme !== "light");
  themeToggle.setAttribute("aria-label", `Switch to ${nextTheme} theme`);
  themeToggle.title = `Switch to ${nextTheme} theme`;
  themeToggle.title = `Switch to ${nextTheme} theme`;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
    "content",
    effectiveTheme() === "dark" ? "#0d1117" : "#f6f8fa"
  );
}

function toggleTheme (): void {
  const nextTheme = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = nextTheme;
  try {
    localStorage.setItem("minug-theme", nextTheme);
  } catch {}
  updateThemeControl();
}

function setInputMessage (message = ""): void {
  inputMessage.textContent = message;
}

function clearResult (): void {
  currentResult = undefined;
  currentQr = undefined;
  resultPanel.hidden = true;
  qrPanel.hidden = true;
  qrStatus.hidden = true;
  saveQr.disabled = true;
}

function clearCanonicalizationFeedback (): void {
  riskConfirmation.hidden = true;
  cleanupWarning.hidden = true;
  cleanupWarning.textContent = "";
  cleanupDetails.hidden = true;
  cleanupDetails.open = false;
  cleanupSummary.textContent = "";
  cleanupList.replaceChildren();
}

function friendlyError (error: unknown): string {
  if (error instanceof CanonicalizationError) {
    if (error.code === "invalid-url") return "Enter a complete link beginning with http:// or https://.";
    if (error.code === "unsupported-protocol") return "Only http:// and https:// links are supported.";
  }
  if (error instanceof Error && /limit|too (?:long|large)/iu.test(error.message)) {
    return "That link is too long to compress.";
  }
  return "This link could not be compressed safely.";
}

function compressionDetail (inputLength: number, outputLength: number): string {
  const difference = inputLength - outputLength;
  return difference > 0
    ? `${Math.round(difference / inputLength * 100)}% shorter`
    : difference < 0
      ? `${Math.round(-difference / inputLength * 100)}% longer`
      : "the same length";
}

function linkTarget (fragment: string, navigationLink: string): string {
  if (!localHostnames.has(window.location.hostname)) return navigationLink;
  const local = new URL(window.location.href);
  local.hash = fragment;
  return local.href;
}

function selectedPreset (): CanonicalizationPreset {
  const value = canonicalizationPreset.value;
  if (value === "exact" || value === "clean" || value === "aggressive") return value;
  return "clean";
}

function updateCanonicalizationHelp (): void {
  switch (selectedPreset()) {
    case "exact":
      canonicalizationHelp.textContent = "Preserve all URL data after browser-safe parsing.";
      break;
    case "clean":
      canonicalizationHelp.textContent = "Remove conservatively identified tracking parameters.";
      break;
    case "aggressive":
      canonicalizationHelp.textContent = "Also unwrap known redirects and simplify known URL patterns.";
      break;
  }
}

function removedParameterName (change: CanonicalizationChange): string | undefined {
  const before = [...new URL(change.before).searchParams.entries()];
  const remaining = [...new URL(change.after).searchParams.entries()];
  for (const [name, value] of before) {
    const index = remaining.findIndex(candidate => candidate[0] === name && candidate[1] === value);
    if (index === -1) return name;
    remaining.splice(index, 1);
  }
  return undefined;
}

function changeDescription (change: CanonicalizationChange): string {
  switch (change.kind) {
    case "removeParam": {
      const name = removedParameterName(change);
      return name ? `Removed ${name}` : "Removed a tracking parameter";
    }
    case "unwrap":
      return `Unwrapped a ${new URL(change.before).hostname} redirect`;
    case "rewrite":
      return "Simplified a site-specific link";
    case "normalize":
      return "Normalized URL escapes";
    case "dropIndexFile":
      return "Removed a default index filename";
  }
}

function warningDescription (
  warning: CanonicalizationWarning,
  requestedPreset: CanonicalizationPreset
): string {
  switch (warning.code) {
    case "credentials-in-url":
      return "This link includes a username or password. Anyone you share it with can see those credentials.";
    case "signed-url-detected":
      return requestedPreset === "exact"
        ? "This appears to be a signed link. Exact mode preserves it unchanged."
        : "This appears to be a signed link. Cleanup was skipped so the link keeps working.";
    case "unwrap-depth-exceeded":
      return "This link contains too many nested redirects. The original link was kept.";
    case "rule-failed":
      return "One cleanup rule could not be applied safely, so that part was skipped.";
    case "canonicalizer-unstable":
      return "Cleanup could not be verified, so the original link was kept.";
  }
}

function showCanonicalizationFeedback (result: CanonicalizationResult): void {
  if (result.warnings.length > 0) {
    cleanupWarning.textContent = [...new Set(
      result.warnings.map(warning => warningDescription(warning, result.requestedPreset))
    )].join(" ");
    cleanupWarning.dataset.severity = result.warnings.some(warning => warning.severity === "block")
      ? "block"
      : "warn";
    cleanupWarning.hidden = false;
  }

  if (result.changes.length === 0) return;
  const savedCharacters = result.browserUrl.length - result.url.length;
  const changeLabel = result.changes.length === 1 ? "change" : "changes";
  cleanupSummary.textContent = `Cleanup made ${result.changes.length} ${changeLabel}${
    savedCharacters > 0 ? ` · ${savedCharacters} characters removed` : ""
  }`;
  for (const change of result.changes) {
    const item = document.createElement("li");
    item.textContent = changeDescription(change);
    cleanupList.append(item);
  }
  cleanupDetails.hidden = false;
}

function hasUnconfirmedBlockingWarning (result: CanonicalizationResult, raw: string): boolean {
  return result.warnings.some(warning => warning.severity === "block") && confirmedRiskInput !== raw;
}

function updateOutput (): void {
  if (!codec) return;
  const pasted = input.value;
  const raw = pasted.trim();
  clearCanonicalizationFeedback();
  if (raw.length === 0) {
    setInputMessage();
    clearResult();
    return;
  }

  try {
    const canonical = canonicalize(raw, { preset: selectedPreset() });
    if (hasUnconfirmedBlockingWarning(canonical, raw)) {
      clearResult();
      setInputMessage();
      riskMessage.textContent = "This link contains a username or password. Shortening it will make those credentials shareable.";
      riskConfirmation.hidden = false;
      return;
    }
    const fragment = codec.encodeFragment(canonical.url);
    const displayLink = `${DISPLAY_LINK_PREFIX}${fragment}`;
    const navigationLink = `${NAVIGATION_LINK_PREFIX}${fragment}`;

    currentResult = { displayLink, fragment, navigationLink };
    outputLink.textContent = displayLink;
    outputLink.href = linkTarget(fragment, navigationLink);
    resultDetail.textContent = compressionDetail(pasted.length, displayLink.length);
    setInputMessage();
    resultPanel.hidden = false;
    copyButton.textContent = "Copy";
    showCanonicalizationFeedback(canonical);

    if (showQr.checked) void renderQr();
  } catch (error) {
    clearResult();
    setInputMessage(friendlyError(error));
  }
}

function scheduleUpdate (): void {
  window.clearTimeout(updateTimer);
  updateTimer = window.setTimeout(updateOutput, 110);
}

function selectedQrCorrection (qrModule: QrModule) {
  switch (qrCorrection.value) {
    case "0": return qrModule.correction.L;
    case "2": return qrModule.correction.Q;
    case "3": return qrModule.correction.H;
    default: return qrModule.correction.M;
  }
}

function updateQrCorrectionLabel (): void {
  const index = Number.parseInt(qrCorrection.value, 10);
  qrCorrectionLabel.value = qrCorrectionLabels[index] ?? "Medium";
}

async function copyText (value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const fallback = document.createElement("textarea");
  fallback.value = value;
  fallback.setAttribute("readonly", "");
  fallback.style.position = "fixed";
  fallback.style.opacity = "0";
  document.body.append(fallback);
  fallback.select();
  const copied = document.execCommand("copy");
  fallback.remove();
  if (!copied) throw new Error("Clipboard copy was rejected");
}

async function renderQr (): Promise<void> {
  if (!currentResult || !showQr.checked) return;
  const generation = ++renderGeneration;
  qrPanel.hidden = false;
  qrStatus.hidden = true;
  qrStatus.textContent = "";
  currentQr = undefined;
  saveQr.disabled = true;
  try {
    qrModulePromise ??= import("lean-qr");
    const qrModule = await qrModulePromise;
    if (generation !== renderGeneration || !currentResult || !showQr.checked) return;
    currentQr = qrModule.generate(currentResult.navigationLink, {
      minCorrectionLevel: selectedQrCorrection(qrModule),
      maxCorrectionLevel: qrModule.correction.H
    });
    currentQr.toCanvas(qrCanvas, {
      on: [18, 20, 22, 255],
      off: [255, 255, 255, 255],
      pad: 4
    });
    qrCanvas.title = currentResult.navigationLink;
    saveQr.disabled = false;
  } catch (error) {
    currentQr = undefined;
    qrStatus.textContent = "The QR code could not be generated.";
    qrStatus.hidden = false;
    console.error(error);
  }
}

async function downloadQr (): Promise<void> {
  if (!currentQr || !currentResult) return;
  saveQr.disabled = true;
  const exportCanvas = document.createElement("canvas");
  const scale = Math.max(8, Math.ceil(1200 / qrCanvas.width));
  exportCanvas.width = qrCanvas.width * scale;
  exportCanvas.height = qrCanvas.height * scale;
  const context = exportCanvas.getContext("2d");
  if (!context) throw new Error("Canvas export is unavailable");
  context.imageSmoothingEnabled = false;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
  context.drawImage(qrCanvas, 0, 0, exportCanvas.width, exportCanvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    exportCanvas.toBlob(value => {
      if (value) resolve(value);
      else reject(new Error("The browser could not create a PNG"));
    }, "image/png");
  });
  const objectUrl = URL.createObjectURL(blob);
  const download = document.createElement("a");
  download.href = objectUrl;
  download.download = "min-ug-qr.png";
  document.body.append(download);
  download.click();
  download.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  saveQr.textContent = "Saved";
  window.setTimeout(() => {
    saveQr.textContent = "Save PNG";
    saveQr.disabled = false;
  }, 1_400);
}

function showRedirect (target: string): void {
  redirectLink.textContent = target;
  redirectLink.href = target;
  compressorView.hidden = true;
  redirectView.hidden = false;
  continueLink.onclick = () => window.location.assign(target);
  redirectView.focus();
}

function showCompressor (): void {
  redirectView.hidden = true;
  compressorView.hidden = false;
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  input.focus();
}

function handleHashChange (): void {
  if (!codec) return;
  if (window.location.hash.length > 1) {
    try {
      showRedirect(codec.decodeHash(window.location.hash));
      return;
    } catch (error) {
      console.error(error);
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      showCompressor();
      setInputMessage("This compressed link is invalid.");
      return;
    }
  }
  showCompressor();
  updateOutput();
}

async function initialize (): Promise<void> {
  try {
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`Wasm request failed with ${response.status}`);
    codec = await instantiateV1Codec(await response.arrayBuffer());
    handleHashChange();
  } catch (error) {
    setInputMessage("The compressor could not load. Refresh the page.");
    console.error(error);
  }
}

form.addEventListener("submit", event => event.preventDefault());
themeToggle.addEventListener("click", toggleTheme);
systemTheme.addEventListener("change", () => {
  if (document.documentElement.dataset.theme === undefined) updateThemeControl();
});
input.addEventListener("input", () => {
  confirmedRiskInput = undefined;
  scheduleUpdate();
});
canonicalizationPreset.addEventListener("change", () => {
  confirmedRiskInput = undefined;
  updateCanonicalizationHelp();
  updateOutput();
});
confirmRisk.addEventListener("click", () => {
  confirmedRiskInput = input.value.trim();
  updateOutput();
});
copyButton.addEventListener("click", () => {
  if (!currentResult) return;
  void copyText(currentResult.displayLink).then(() => {
    copyButton.textContent = "Copied";
    window.setTimeout(() => { copyButton.textContent = "Copy"; }, 1_400);
  }).catch(error => {
    copyButton.textContent = "Copy failed";
    console.error(error);
  });
});
showQr.addEventListener("change", () => {
  renderGeneration += 1;
  qrPanel.hidden = !showQr.checked;
  if (showQr.checked) void renderQr();
});
qrCorrection.addEventListener("input", () => {
  updateQrCorrectionLabel();
  renderGeneration += 1;
  if (showQr.checked) void renderQr();
});
saveQr.addEventListener("click", () => {
  void downloadQr().catch(error => {
    saveQr.disabled = false;
    qrStatus.textContent = "The PNG could not be saved by this browser.";
    qrStatus.hidden = false;
    console.error(error);
  });
});
backHome.addEventListener("click", showCompressor);
window.addEventListener("hashchange", handleHashChange);

updateCanonicalizationHelp();
updateQrCorrectionLabel();
updateThemeControl();
void initialize();
