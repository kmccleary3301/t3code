import { requireNativeModule } from "expo";

export interface MobileSshNative {
  readonly inspectHost: (host: string, port: number) => Promise<{ readonly fingerprint: string }>;
  readonly connect: (
    host: string,
    port: number,
    username: string,
    password: string | null,
    privateKey: string | null,
    passphrase: string | null,
    expectedFingerprint: string | null,
  ) => Promise<{ readonly sessionId: string; readonly fingerprint: string }>;
  readonly exec: (
    sessionId: string,
    command: string,
    stdin: string | null,
  ) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
  readonly forward: (
    sessionId: string,
    remoteHost: string,
    remotePort: number,
  ) => Promise<{ readonly localPort: number }>;
  readonly disconnect: (sessionId: string) => Promise<void>;
}

export const mobileSshNative = requireNativeModule<MobileSshNative>("T3Ssh");
