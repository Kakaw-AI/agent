import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, Socket, type LookupFunction } from "node:net";

// Users hand us hostnames (their Postgres, their own LLM endpoint) and this
// process dials them from inside the deployment network. Without a guard that
// is a tunnel to everything that network can reach: the app database, other
// containers, the cloud metadata address.

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT (also Tailscale)
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(address, prefix, "ipv6");
}

/**
 * On in production only: local development has to reach localhost. A
 * self-hosted install that really does keep its database or model server on a
 * private network opts out with ALLOW_PRIVATE_HOSTS=true.
 */
function guardEnabled(): boolean {
  return (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_PRIVATE_HOSTS !== "true"
  );
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) {
    return true;
  }
  // BlockList matches IPv4-mapped IPv6 (::ffff:10.0.0.1) against the IPv4 rules.
  return blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

/**
 * An IP literal the guard refuses. Sockets skip `lookup` for IP literals, so a
 * client that dials hosts it did not resolve itself (MongoDB replica-set
 * members a server announces) has to check them here.
 */
export function isBlockedLiteral(host: string): boolean {
  return guardEnabled() && isIP(host) !== 0 && isBlockedAddress(host);
}

function privateHostError(host: string): Error {
  return new Error(
    `"${host}" is a private or internal address and cannot be used here.`,
  );
}

/**
 * Drop-in for dns.lookup that refuses private addresses. Passed as a socket's
 * `lookup`, so the check runs on the address that is actually dialled — a
 * separate resolve-then-connect would leave a DNS-rebinding gap.
 */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }
    const list = addresses as LookupAddress[];
    if (
      list.length === 0 ||
      (guardEnabled() && list.some((entry) => isBlockedAddress(entry.address)))
    ) {
      callback(privateHostError(hostname), []);
      return;
    }
    if (options.all) {
      callback(null, list);
    } else {
      callback(null, list[0].address, list[0].family);
    }
  });
};

/** Resolves a hostname (or checks a literal IP) and rejects private targets. */
export function assertPublicHost(host: string): Promise<void> {
  if (!guardEnabled()) {
    return Promise.resolve();
  }
  if (isIP(host)) {
    return isBlockedAddress(host)
      ? Promise.reject(privateHostError(host))
      : Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    publicLookup(host, { all: true }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

/** For user-supplied HTTP endpoints (a custom LLM base URL). */
export async function assertPublicUrl(value: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The URL is not valid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed.");
  }
  // URL keeps the brackets on IPv6 literals; net.isIP wants them gone.
  await assertPublicHost(url.hostname.replace(/^\[|\]$/g, ""));
}

/**
 * Socket factory for pg (`stream` option). pg calls `connect(port, host)` for
 * TCP and `connect(path)` for a unix socket; both are routed through the guard.
 */
export function guardedSocket(): Socket {
  const socket = new Socket();
  const connect = socket.connect.bind(socket) as (...args: unknown[]) => Socket;

  socket.connect = ((...args: unknown[]) => {
    if (!guardEnabled()) {
      return connect(...args);
    }
    const [port, host] = args;
    if (
      typeof port !== "number" ||
      typeof host !== "string" ||
      (isIP(host) !== 0 && isBlockedAddress(host))
    ) {
      // Emitted on the next tick: pg attaches its error listener after connect().
      process.nextTick(() => socket.destroy(privateHostError(String(host ?? port))));
      return socket;
    }
    return connect({ port, host, lookup: publicLookup });
  }) as Socket["connect"];

  return socket;
}
