interface TunnelOutputServer {
  listen: (...args: never[]) => Promise<object>;
  printUrls: () => void;
}

/**
 * Print Vite's resolved URLs after the Cloudflare plugin's auto-started tunnel
 * is ready. The Cloudflare plugin wraps `listen()` to start the tunnel, so a
 * post-enforced wrapper can call its patched `printUrls()` with the public URL
 * available.
 */
export const cloudflareTunnelOutputPlugin = () => {
  let printed = false;

  return {
    configureServer(server: TunnelOutputServer) {
      const listen = server.listen.bind(server);
      server.listen = async (...args) => {
        const result = await listen(...args);
        if (!printed) {
          printed = true;
          server.printUrls();
        }
        return result;
      };
    },
    enforce: "post" as const,
    name: "blume:cloudflare-tunnel-output",
  };
};
