// The host names the app answers to, and the page origins it accepts a
// write from. The server binds 127.0.0.1 only. By default it answers only
// to 127.0.0.1:<port> and localhost:<port>, so a page on another site
// cannot reach it through DNS rebinding.
//
// APP_ALLOWED_HOSTS adds host names, comma-separated, for a private proxy
// on the same computer, such as Tailscale serve on the owner's tailnet
// name. A name without a port is accepted as given (the proxy's own port,
// 443 for HTTPS) and with the app's port. The page origin may be http or
// https for each.

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;

export class AllowedHostsError extends Error {}

// Reads APP_ALLOWED_HOSTS. Empty or unset adds nothing. An entry that is
// not a plain host name, with an optional port, stops the app at start, so
// a typo cannot widen the check.
export function parseAllowedHosts(value: string | undefined): string[] {
  if (!value || value.trim() === "") return [];
  return value.split(",").map((raw) => {
    const name = raw.trim().toLowerCase();
    if (!HOST_NAME.test(name)) {
      throw new AllowedHostsError(`APP_ALLOWED_HOSTS has an entry that is not a host name: "${raw.trim()}". Use names such as my-box.tailnet-name.ts.net, separated by commas.`);
    }
    return name;
  });
}

export type AppHosts = {
  // Host header values the server answers to, lower case.
  hosts: ReadonlySet<string>;
  // Origins a write may come from.
  origins: string[];
  // Host names without ports, for Vite's own check in development.
  names: string[];
};

export function appHosts(port: number, extra: readonly string[] = []): AppHosts {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  for (const name of extra) {
    const withPort = /:\d+$/.test(name) ? [name] : [name, `${name}:${port}`];
    for (const h of withPort) {
      hosts.add(h);
      origins.add(`http://${h}`);
      origins.add(`https://${h}`);
    }
  }
  return { hosts, origins: [...origins], names: ["127.0.0.1", "localhost", ...extra.map((n) => n.replace(/:\d+$/, ""))] };
}

// True when the Host header names this app.
export function hostAllowed(allowed: AppHosts, host: string | undefined): boolean {
  return host !== undefined && allowed.hosts.has(host.toLowerCase());
}
