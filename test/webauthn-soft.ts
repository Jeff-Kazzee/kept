// A software passkey for offline tests (0020, B3): one P-256 key, the
// "none" attestation and the WebAuthn JSON forms a browser hands to the
// page, so Better Auth's passkey plugin can register it and sign in with
// it. Test use only. Nothing here reaches the network.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

const b64url = (b: Buffer) => b.toString("base64url");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

// Just enough CBOR for an attestation object and a COSE key.
function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}
type Cbor = number | string | Buffer | Map<Cbor, Cbor>;
function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === "string") {
    const s = Buffer.from(v, "utf8");
    return Buffer.concat([cborHead(3, s.length), s]);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
  const parts = [cborHead(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return Buffer.concat(parts);
}

export class SoftPasskey {
  readonly credentialId = randomBytes(16);
  readonly #privateKey: KeyObject;
  readonly #publicJwk: { x: string; y: string };
  #counter = 0;
  userHandle: string | null = null;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.#privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    this.#publicJwk = { x: jwk.x, y: jwk.y };
  }

  #clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  // The answer to navigator.credentials.create(), as JSON.
  register(options: { challenge: string; rp: { id: string }; user: { id: string } }, origin: string) {
    this.userHandle = options.user.id;
    const cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(this.#publicJwk.x, "base64url")],
        [-3, Buffer.from(this.#publicJwk.y, "base64url")],
      ]),
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.#counter);
    // User present, user verified, attested credential data.
    const authData = Buffer.concat([sha256(options.rp.id), Buffer.from([0x45]), counter, Buffer.alloc(16), idLength, this.credentialId, cose]);
    const attestationObject = cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    const id = b64url(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: { clientDataJSON: b64url(this.#clientData("webauthn.create", options.challenge, origin)), attestationObject: b64url(attestationObject), transports: ["internal"] },
    };
  }

  // The answer to navigator.credentials.get(), as JSON.
  authenticate(options: { challenge: string; rpId: string }, origin: string, overrides: { rpId?: string; origin?: string } = {}) {
    this.#counter++;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.#counter);
    const authData = Buffer.concat([sha256(overrides.rpId ?? options.rpId), Buffer.from([0x05]), counter]);
    const clientData = this.#clientData("webauthn.get", options.challenge, overrides.origin ?? origin);
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientData)]), this.#privateKey);
    const id = b64url(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(signature), ...(this.userHandle ? { userHandle: this.userHandle } : {}) },
    };
  }
}
