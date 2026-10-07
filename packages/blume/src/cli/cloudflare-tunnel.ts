import { spawn } from "node:child_process";
import { once } from "node:events";

export interface CloudflareTunnelProcess {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill: (signal?: NodeJS.Signals) => boolean;
  onError: (listener: (error: Error) => void) => void;
}

export interface CloudflareTunnelHandle {
  readonly exited: Promise<number>;
  stop: () => Promise<void>;
}

export type CloudflareTunnelSpawner = (
  args: string[]
) => CloudflareTunnelProcess;

export interface CloudflareTunnelCallbacks {
  onError: (error: Error) => void;
}

export const cloudflaredArgs = (port: number, host = "127.0.0.1"): string[] => [
  "cloudflared",
  "tunnel",
  "--url",
  `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
];

export const createCloudflareTunnelSpawner =
  (
    executable = "cloudflared",
    prefixArgs: string[] = []
  ): CloudflareTunnelSpawner =>
  (args) => {
    const child = spawn(executable, [...prefixArgs, ...args.slice(1)], {
      stdio: ["ignore", "inherit", "inherit"] as const,
    });
    const exited = (async () => {
      try {
        const [code] = await once(child, "exit");
        return code ?? 1;
      } catch {
        return 127;
      }
    })();
    return {
      get exitCode() {
        return child.exitCode;
      },
      exited,
      kill: (signal) => child.kill(signal),
      onError: (listener) => {
        child.once("error", listener);
      },
    };
  };

const spawnCloudflared = createCloudflareTunnelSpawner();

export const startCloudflareTunnel = (
  port: number,
  host: string,
  callbacks: CloudflareTunnelCallbacks,
  spawnTunnel: CloudflareTunnelSpawner = spawnCloudflared
): CloudflareTunnelHandle => {
  const child = spawnTunnel(cloudflaredArgs(port, host));
  child.onError(callbacks.onError);

  return {
    exited: child.exited,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      await child.exited;
    },
  };
};
