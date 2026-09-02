// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side fixtures own disposable servers and filesystem state.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
export const ACTUAL_SURFACE_SERVER_HOST = "0.0.0.0";

export const EVIDENCE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "CI",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "JAVA_HOME",
  "DEVELOPER_DIR",
  "RUNNER_TEMP",
  "EXPO_NO_DOTENV",
  "SHELL",
  "NO_COLOR",
  "NODE_ENV",
] as const;
type EvidenceEnvKey = (typeof EVIDENCE_ENV_ALLOWLIST)[number];
const SECRET_ENV_NAME = /(token|secret|password|credential|private|api[_-]?key|auth)/iu;

/** Build a child environment from an explicit, non-secret allowlist. */
export function createActualSurfaceChildEnv(
  baseEnvironment: Readonly<Record<string, string | undefined>> = NodeProcess.env,
  overrides: Readonly<Partial<Record<EvidenceEnvKey, string>>> = {},
): Readonly<Record<string, string>> {
  for (const key of Object.keys(overrides)) {
    const allowed = EVIDENCE_ENV_ALLOWLIST.some((candidate) => candidate === key);
    if (!allowed || SECRET_ENV_NAME.test(key)) {
      throw new Error(`Refusing secret or non-allowlisted child environment override '${key}'.`);
    }
  }
  const result: Record<string, string> = {};
  for (const key of EVIDENCE_ENV_ALLOWLIST) {
    const value = overrides[key] ?? baseEnvironment[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function stopActualSurfaceProcess(
  child: NodeChildProcess.ChildProcess,
  options: { readonly processGroup?: boolean } = {},
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const signal = (signalName: NodeJS.Signals): void => {
    if (options.processGroup && NodeProcess.platform !== "win32" && child.pid !== undefined) {
      try {
        NodeProcess.kill(-child.pid, signalName);
        return;
      } catch {
        // The process may have exited between the liveness check and signal.
      }
    }
    child.kill(signalName);
  };
  signal("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    signal("SIGKILL");
    await Promise.race([exited, delay(1_000)]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`Failed to stop evidence process${child.pid ? ` ${child.pid}` : ""}.`);
  }
}

/** Reserve and immediately release a loopback port before starting a server. */
export async function reserveAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local port for the actual-surface environment."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

export async function waitForPort(
  port: number,
  label = "Process",
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (open) return;
    await delay(500);
  }
  throw new Error(`${label} did not begin listening on port ${port} within ${timeoutMs}ms.`);
}

export async function waitForFileContent(
  filePath: string,
  label: string,
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await NodeFSP.readFile(filePath, "utf8").then(
      (value) => value.trim(),
      () => "",
    );
    if (content) return content;
    await delay(250);
  }
  throw new Error(`${label} was not written to ${filePath} within ${timeoutMs}ms.`);
}

export async function createShowcaseShell(baseDir: string): Promise<string> {
  const shellPath = NodePath.join(baseDir, "showcase-shell");
  await NodeFSP.writeFile(
    shellPath,
    `#!/bin/sh
if [ "$1" = "-ilc" ] || [ "$1" = "-lic" ]; then
  exec /bin/sh -c "$2"
fi
exec /bin/cat
`,
    { mode: 0o755 },
  );
  return shellPath;
}

export async function createShowcaseLabelProbe(baseDir: string, label: string): Promise<string> {
  const binDirectory = NodePath.join(baseDir, "showcase-bin");
  await NodeFSP.mkdir(binDirectory, { recursive: true });
  const probeScript = `#!/bin/sh
if [ "$1" = "--get" ] && [ "$2" = "ComputerName" ]; then
  printf '%s\\n' ${JSON.stringify(label)}
  exit 0
fi
if [ "$1" = "--pretty" ]; then
  printf '%s\\n' ${JSON.stringify(label)}
  exit 0
fi
exit 1
`;
  await Promise.all(
    ["scutil", "hostnamectl"].map((executable) =>
      NodeFSP.writeFile(NodePath.join(binDirectory, executable), probeScript, { mode: 0o755 }),
    ),
  );
  return binDirectory;
}

export function startShowcaseServer(input: {
  readonly baseDir: string;
  readonly workspaceRoot: string;
  readonly port: number;
  readonly shellPath: string;
  readonly labelProbeDirectory: string;
}): NodeChildProcess.ChildProcess {
  return NodeChildProcess.spawn(
    "node",
    [
      "apps/server/src/bin.ts",
      "serve",
      "--host",
      ACTUAL_SURFACE_SERVER_HOST,
      "--port",
      String(input.port),
      "--base-dir",
      input.baseDir,
      "--no-browser",
      "--log-level",
      "error",
      input.workspaceRoot,
    ],
    {
      cwd: NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), ".."),
      env: createActualSurfaceChildEnv(NodeProcess.env, {
        HOME: NodePath.join(input.baseDir, "home"),
        TMPDIR: NodePath.join(input.baseDir, "tmp"),
        PATH: `${input.labelProbeDirectory}:${NodeProcess.env.PATH ?? ""}`,
        SHELL: input.shellPath,
      }),
      // Pairing credentials are printed during startup. Evidence subprocesses
      // never inherit their output streams.
      stdio: "ignore",
    },
  );
}

export async function commandOutput(
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.ExecFileOptions = {},
): Promise<string> {
  const result = await execFile(command, [...args], {
    ...options,
    cwd: NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), ".."),
    encoding: "utf8",
    env: options.env ?? createActualSurfaceChildEnv(NodeProcess.env),
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout;
}

const PairingCredentialSchema = Schema.Struct({
  credential: Schema.String.check(Schema.isPattern(/\S/u)),
});

export function parsePairingCredentialOutput(output: string): string {
  const jsonStart = output.indexOf("{");
  const jsonEnd = output.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd < jsonStart)
    throw new Error("Pairing credential command did not return JSON.");
  return Schema.decodeUnknownSync(PairingCredentialSchema)(
    JSON.parse(output.slice(jsonStart, jsonEnd + 1)),
  ).credential;
}

export async function issuePairingCredential(baseDir: string): Promise<string> {
  const output = await commandOutput(
    "node",
    ["apps/server/src/bin.ts", "auth", "pairing", "create", "--base-dir", baseDir, "--json"],
    {
      env: createActualSurfaceChildEnv(NodeProcess.env, {
        HOME: NodePath.join(baseDir, "home"),
        TMPDIR: NodePath.join(baseDir, "tmp"),
        NO_COLOR: "1",
      }),
    },
  );
  return parsePairingCredentialOutput(output);
}

/** The URL is returned to callers only; it is never written to logs or files. */
export function buildShowcasePairingUrl(host: string, port: number, credential: string): string {
  const url = new URL(`http://${host}:${port}/`);
  url.hash = new URLSearchParams([["token", credential]]).toString();
  return url.toString();
}

export function redactActualSurfaceLog(
  message: string,
  secrets: ReadonlyArray<string> = [],
): string {
  let result = message;
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join("[REDACTED]");
  }
  result = result.replace(
    /((?:authorization|token|secret|password|credential|api[-_]?key)\s*[=:]\s*)(?:bearer\s+)?[^\s,;}]+/giu,
    "$1[REDACTED]",
  );
  result = result.replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED]");
  return result.replace(/((?:https?|wss?):\/\/[^\s"'<>]+)[\s]*/gu, (value) => {
    try {
      const url = new URL(value.trim());
      return `${url.origin}${url.pathname} `;
    } catch {
      return value.replace(/[?#].*$/u, " ");
    }
  });
}

export interface ActualSurfaceEnvironment {
  readonly baseDir: string;
  readonly workspaceRoot: string;
  readonly label: string;
  readonly port: number;
  readonly server: NodeChildProcess.ChildProcess;
  readonly pairingUrl: (host: string) => Promise<string>;
  readonly dispose: () => Promise<void>;
}

/** Start one server and own all temporary resources until scoped disposal. */
export async function createActualSurfaceEnvironment(input: {
  readonly baseDir: string;
  readonly workspaceRoot: string;
  readonly label: string;
  readonly prepare?: () => Promise<void>;
  readonly temporaryRoot?: boolean;
}): Promise<ActualSurfaceEnvironment> {
  const relativeWorkspace = NodePath.relative(input.baseDir, input.workspaceRoot);
  if (
    input.temporaryRoot &&
    (relativeWorkspace.startsWith("..") || NodePath.isAbsolute(relativeWorkspace))
  ) {
    throw new Error("An owned actual-surface workspace must be inside its temporary root.");
  }
  const markerPath = NodePath.join(input.baseDir, ".t3-actual-surface-temporary");
  let ownsBaseDir = false;
  try {
    if (input.temporaryRoot) {
      await NodeFSP.mkdir(input.baseDir, { recursive: false, mode: 0o700 });
      ownsBaseDir = true;
    } else {
      await NodeFSP.mkdir(input.baseDir, { recursive: true });
    }
    await Promise.all([
      NodeFSP.mkdir(input.workspaceRoot, { recursive: true }),
      NodeFSP.mkdir(NodePath.join(input.baseDir, "home"), { recursive: true, mode: 0o700 }),
      NodeFSP.mkdir(NodePath.join(input.baseDir, "tmp"), { recursive: true, mode: 0o700 }),
    ]);
    if (ownsBaseDir) {
      await NodeFSP.writeFile(markerPath, "created-by-actual-surface-environment\n", {
        flag: "wx",
        mode: 0o600,
      });
    }
  } catch (error) {
    if (ownsBaseDir) await NodeFSP.rm(input.baseDir, { recursive: true, force: true });
    throw error;
  }
  let launchCleanupFailed = false;
  const launched = await (async () => {
    const port = await reserveAvailablePort();
    const shellPath = await createShowcaseShell(input.baseDir);
    const labelProbeDirectory = await createShowcaseLabelProbe(input.baseDir, input.label);
    const server = startShowcaseServer({
      baseDir: input.baseDir,
      workspaceRoot: input.workspaceRoot,
      port,
      shellPath,
      labelProbeDirectory,
    });
    try {
      await waitForPort(port, `${input.label} server`);
      await input.prepare?.();
      return { port, server };
    } catch (error) {
      try {
        await stopActualSurfaceProcess(server);
      } catch (cleanupError) {
        launchCleanupFailed = true;
        throw new AggregateError(
          [error, cleanupError],
          "Actual-surface server launch failed and its process could not be stopped.",
        );
      }
      throw error;
    }
  })().catch(async (error: unknown) => {
    if (ownsBaseDir && !launchCleanupFailed)
      await NodeFSP.rm(input.baseDir, { recursive: true, force: true });
    throw error;
  });
  const { port, server } = launched;
  let disposed = false;
  return {
    baseDir: input.baseDir,
    workspaceRoot: input.workspaceRoot,
    label: input.label,
    port,
    server,
    pairingUrl: async (host: string) =>
      buildShowcasePairingUrl(host, port, await issuePairingCredential(input.baseDir)),
    dispose: async () => {
      if (disposed) return;
      await stopActualSurfaceProcess(server);
      if (ownsBaseDir) {
        const marker = await NodeFSP.readFile(markerPath, "utf8").catch(() => "");
        if (marker === "created-by-actual-surface-environment\n") {
          await NodeFSP.rm(input.baseDir, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
          });
        }
      }
      disposed = true;
    },
  };
}
