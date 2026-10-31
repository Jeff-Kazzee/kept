// The app's two modes (0014, design item 1) and the settings of hosted
// mode, read from the environment once at start. APP_MODE is checked in
// both modes. The hosted-only settings are read and checked only in hosted
// mode, so local mode runs as it did before sprint 13 (review round 1,
// finding 7). A value that does not parse stops the app, so a typo cannot
// widen a cap or turn a guard off.
//
//   APP_MODE                 local (the default) or hosted
//   APP_MARKUP               what a person pays per unit of model cost,
//                            default 3, at most two decimals
//   APP_DAILY_COST_CAP_USD   the most the server key may cost Jeff in one
//                            UTC day. No default (J19).
//   APP_JUDGE_TOTAL_CAP_USD  the most all judge codes together may grant.
//                            No default (J19).
//   APP_SERVER_KEY           off stops every call on the server key
//   APP_TRUSTED_PROXY        cloudflare trusts CF-Connecting-IP from a
//                            loopback socket. tailscale trusts
//                            X-Forwarded-For from a loopback socket, as
//                            Tailscale serve and Funnel set it (0020, B11).
//                            none, the default, trusts no forwarding header
//                            (finding 4).
//   APP_DEMO_GOOGLE          on shares one made-up person's Gmail and Google
//                            Calendar with every account that has no Google
//                            connection of its own (0021). Default off.
//
// J19: while either cap is unset the server key is off, and `missing`
// names what to set. Money is kept in micro-dollars (millionths of a
// dollar), as integers.
export type AppMode = "local" | "hosted";
export type TrustedProxy = "none" | "cloudflare" | "tailscale";

export type HostedConfig = {
  mode: AppMode;
  // The markup in hundredths: 300 is 3 times the model's cost.
  markupHundredths: number;
  dailyCapMicros: number | null;
  judgeTotalCapMicros: number | null;
  // False when APP_SERVER_KEY is off, or a cap is unset (J19).
  serverKeyOn: boolean;
  trustedProxy: TrustedProxy;
  // APP_DEMO_GOOGLE=on (0021). Always false in local mode (D10).
  demoGoogle: boolean;
  // The required settings that are not set.
  missing: string[];
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

export const MICROS_PER_USD = 1_000_000;

// A plain decimal with at most `places` digits after the point, as an
// integer count of 10^-places. Never parsed as a float.
export function parseDecimal(raw: string, places: number): number | null {
  const m = /^(\d{1,9})(?:\.(\d+))?$/.exec(raw.trim());
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > places) return null;
  return Number(m[1]) * 10 ** places + Number(frac.padEnd(places, "0") || "0");
}

// Dollars, such as "20" or "2.50", in micro-dollars.
export function parseUsd(raw: string): number | null {
  return parseDecimal(raw, 6);
}

// A required amount, or null when it is not set.
function usd(env: NodeJS.ProcessEnv, name: string): number | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const v = parseUsd(raw);
  if (v === null) throw new ConfigError(`${name} must be an amount in dollars, such as 20 or 2.50. It is "${raw}".`);
  return v;
}

const LOCAL: Omit<HostedConfig, "mode"> = { markupHundredths: 300, dailyCapMicros: null, judgeTotalCapMicros: null, serverKeyOn: false, trustedProxy: "none", demoGoogle: false, missing: [] };

export function readHostedConfig(env: NodeJS.ProcessEnv = process.env): HostedConfig {
  const modeRaw = (env.APP_MODE ?? "").trim().toLowerCase();
  if (modeRaw !== "" && modeRaw !== "local" && modeRaw !== "hosted") throw new ConfigError(`APP_MODE must be local or hosted. It is "${env.APP_MODE}".`);
  if (modeRaw !== "hosted") return { mode: "local", ...LOCAL };
  const markupRaw = env.APP_MARKUP;
  let markupHundredths = 300;
  if (markupRaw !== undefined && markupRaw.trim() !== "") {
    const v = parseDecimal(markupRaw, 2);
    // A markup below 1 would sell usage below its cost.
    if (v === null || v < 100) throw new ConfigError(`APP_MARKUP must be a number of 1 or more, with at most two decimals. It is "${markupRaw}".`);
    markupHundredths = v;
  }
  const keyRaw = (env.APP_SERVER_KEY ?? "").trim().toLowerCase();
  if (keyRaw !== "" && keyRaw !== "on" && keyRaw !== "off") throw new ConfigError(`APP_SERVER_KEY must be on or off. It is "${env.APP_SERVER_KEY}".`);
  const proxyRaw = (env.APP_TRUSTED_PROXY ?? "").trim().toLowerCase();
  if (proxyRaw !== "" && proxyRaw !== "none" && proxyRaw !== "cloudflare" && proxyRaw !== "tailscale") throw new ConfigError(`APP_TRUSTED_PROXY must be tailscale, cloudflare or none. It is "${env.APP_TRUSTED_PROXY}".`);
  const demoRaw = (env.APP_DEMO_GOOGLE ?? "").trim().toLowerCase();
  if (demoRaw !== "" && demoRaw !== "on" && demoRaw !== "off") throw new ConfigError(`APP_DEMO_GOOGLE must be on or off. It is "${env.APP_DEMO_GOOGLE}".`);
  const dailyCapMicros = usd(env, "APP_DAILY_COST_CAP_USD");
  const judgeTotalCapMicros = usd(env, "APP_JUDGE_TOTAL_CAP_USD");
  const missing = [...(dailyCapMicros === null ? ["APP_DAILY_COST_CAP_USD"] : []), ...(judgeTotalCapMicros === null ? ["APP_JUDGE_TOTAL_CAP_USD"] : [])];
  return {
    mode: "hosted",
    markupHundredths,
    dailyCapMicros,
    judgeTotalCapMicros,
    serverKeyOn: keyRaw !== "off" && missing.length === 0,
    trustedProxy: proxyRaw === "cloudflare" || proxyRaw === "tailscale" ? proxyRaw : "none",
    demoGoogle: demoRaw === "on",
    missing,
  };
}

// "$1.25", "$0.0042": dollars with at least two decimals and no trailing
// zeros past them. For display only.
export function formatUsd(micros: number): string {
  const sign = micros < 0 ? "-" : "";
  const abs = Math.abs(micros);
  const whole = Math.floor(abs / MICROS_PER_USD);
  let frac = String(abs % MICROS_PER_USD).padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${sign}$${whole}.${frac}`;
}

// A balance as the page shows it: whole cents, rounded down, so the page
// never shows more credit than there is.
export function formatBalance(micros: number): string {
  return formatUsd(Math.floor(Math.max(0, micros) / 10_000) * 10_000);
}

// A charge as the page shows it: at most four decimals, rounded up, so the
// page never shows less than was charged.
export function formatCharge(micros: number): string {
  return formatUsd(Math.ceil(Math.max(0, micros) / 100) * 100);
}
