#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeStreamWeb from "node:stream/web";

export type RuntimeBundleProvider = "pi" | "omp";
export type RuntimeBundlePlatform = "darwin" | "linux";
export type RuntimeBundleArch = "arm64" | "x64";

export interface RuntimeBundleSpec {
  readonly provider: RuntimeBundleProvider;
  readonly platform: RuntimeBundlePlatform;
  readonly arch: RuntimeBundleArch;
  readonly url: string;
  readonly sha256: string;
  readonly filename: string;
}

const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const ARCHIVE_NAME = /^(?:pi|omp)-runtime-(?:darwin|linux)-(?:arm64|x64)\.(?:tar\.gz|tgz|zip)$/u;
const SHA256 = /^[0-9a-f]{64}$/iu;

function fail(message: string): never {
  throw new Error(message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return fail(`${label}.${key} must be a non-empty string.`);
  }
  return value.trim();
}

function assertHttps(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(`${label}.url is not a valid URL.`);
  }
  if (parsed.protocol !== "https:") fail(`${label}.url must use https://.`);
}

function defaultFilename(spec: Pick<RuntimeBundleSpec, "provider" | "platform" | "arch">): string {
  return `${spec.provider}-runtime-${spec.platform}-${spec.arch}.tar.gz`;
}

export function parseRuntimeBundleConfig(raw: string): ReadonlyArray<RuntimeBundleSpec> {
  const parsed: unknown = JSON.parse(raw);
  const root = Array.isArray(parsed)
    ? parsed
    : asRecord(parsed, "runtime bundle configuration").bundles;
  if (!Array.isArray(root)) fail("runtime bundle configuration must contain a bundles array.");

  const seen = new Set<string>();
  return root.map((value, index) => {
    const label = `bundles[${index}]`;
    const record = asRecord(value, label);
    const provider = stringField(record, "provider", label);
    const platform = stringField(record, "platform", label);
    const arch = stringField(record, "arch", label);
    if (provider !== "pi" && provider !== "omp") fail(`${label}.provider must be pi or omp.`);
    if (platform !== "darwin" && platform !== "linux")
      fail(`${label}.platform must be darwin or linux.`);
    if (arch !== "arm64" && arch !== "x64") fail(`${label}.arch must be arm64 or x64.`);

    const url = stringField(record, "url", label);
    assertHttps(url, label);
    const sha256 = stringField(record, "sha256", label).toLowerCase();
    if (!SHA256.test(sha256)) fail(`${label}.sha256 must be a 64-character hexadecimal digest.`);

    const filename =
      typeof record.filename === "string" && record.filename.trim().length > 0
        ? record.filename.trim()
        : defaultFilename({ provider, platform, arch });
    if (NodePath.basename(filename) !== filename || !ARCHIVE_NAME.test(filename)) {
      fail(`${label}.filename must match ${ARCHIVE_NAME.source}.`);
    }
    const expected = defaultFilename({ provider, platform, arch });
    if (filename !== expected) fail(`${label}.filename must be '${expected}'.`);

    const identity = `${provider}/${platform}/${arch}`;
    if (seen.has(identity)) fail(`Duplicate runtime bundle '${identity}'.`);
    seen.add(identity);
    return { provider, platform, arch, url, sha256, filename };
  });
}

function flag(args: ReadonlyArray<string>, name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value.`);
  return value;
}

function writeGithubOutput(key: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT?.trim();
  if (output) NodeFS.appendFileSync(output, `${key}=${value}\n`);
}

async function downloadBundle(spec: RuntimeBundleSpec, destination: string): Promise<void> {
  let url = spec.url;
  let response: Response | undefined;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    response = await fetch(url, { redirect: "manual" });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location)
      fail(
        `Runtime bundle ${spec.provider}/${spec.platform}/${spec.arch} redirected without a location.`,
      );
    const next = new URL(location, url);
    if (next.protocol !== "https:") fail("Runtime bundle redirects must remain HTTPS.");
    url = next.href;
    response = undefined;
  }
  if (!response)
    fail(
      `Runtime bundle ${spec.provider}/${spec.platform}/${spec.arch} redirected too many times.`,
    );
  if (!response.ok) fail(`Runtime bundle download failed with HTTP ${response.status}.`);
  const body = response.body;
  if (!body)
    fail(`Runtime bundle ${spec.provider}/${spec.platform}/${spec.arch} has no response body.`);
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BUNDLE_BYTES) fail("Runtime bundle exceeds the 512 MiB safety limit.");

  const temporary = `${destination}.partial`;
  const digest = NodeCrypto.createHash("sha256");
  let bytes = 0;
  const meter = new NodeStream.Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > MAX_BUNDLE_BYTES) {
        callback(new Error("Runtime bundle exceeds the 512 MiB safety limit."));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.fromWeb(body as unknown as NodeStreamWeb.ReadableStream),
      meter,
      NodeFS.createWriteStream(temporary, { mode: 0o600 }),
    );
    if (digest.digest("hex") !== spec.sha256)
      fail(`Runtime bundle checksum mismatch for ${spec.filename}.`);
    NodeFS.renameSync(temporary, destination);
  } catch (error) {
    NodeFS.rmSync(temporary, { force: true });
    throw error;
  }
}

export async function prepareRuntimeBundles(
  specs: ReadonlyArray<RuntimeBundleSpec>,
  outputDirectory: string,
): Promise<void> {
  NodeFS.mkdirSync(outputDirectory, { recursive: true });
  for (const spec of specs) {
    await downloadBundle(spec, NodePath.join(outputDirectory, spec.filename!));
  }
}

if (import.meta.main) {
  try {
    const raw = process.env.T3_PI_OMP_RUNTIME_BUNDLES_JSON?.trim() ?? "";
    const outputDirectory = flag(process.argv.slice(2), "--output") ?? "release-runtime-bundles";
    if (raw.length === 0) {
      process.stdout.write(
        "No optional Pi/OMP runtime bundles configured; continuing without them.\n",
      );
      writeGithubOutput("has_assets", "false");
    } else {
      const specs = parseRuntimeBundleConfig(raw);
      await prepareRuntimeBundles(specs, outputDirectory);
      process.stdout.write(`Prepared ${specs.length} optional Pi/OMP runtime bundle(s).\n`);
      writeGithubOutput("has_assets", specs.length > 0 ? "true" : "false");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
