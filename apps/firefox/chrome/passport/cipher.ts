import { testEnv } from "../test-env";

export const PASSPORT_KEY_LABEL = "Ressac Passport";
/** A build that is not packaged never reads nor replaces the DMG's key (design § 4.2). */
export const PASSPORT_KEY_LABEL_DEV = "Ressac Passport (dev)";

export interface PassportCipher {
  /** Whether the key exists; creates nothing. */
  available(): Promise<boolean>;
  ensureKey(): Promise<void>;
  encrypt(plain: string): Promise<string>;
  /** Never creates a key: the OSKeyStore JS module's decrypt does, silently, which is why it is not used. */
  decrypt(cipher: string): Promise<string>;
}

const dev = () => typeof __RESSAC_PACKAGED__ !== "undefined" && __RESSAC_PACKAGED__ === false;

/**
 * The passport's own key in the macOS keychain, through the native nsIOSKeyStore (AES-GCM). `RESSAC_TEST_PASSPORT_CIPHER`
 * (dev builds only, read through testEnv): `memory` (a fixed WebCrypto key, never the keychain) or `absent` (no key).
 */
export function passportCipher(): PassportCipher {
  const seam = testEnv("RESSAC_TEST_PASSPORT_CIPHER");
  if (seam === "memory") return memoryCipher();
  if (seam === "absent") return absentCipher();
  const label = dev() ? PASSPORT_KEY_LABEL_DEV : PASSPORT_KEY_LABEL;
  const keystore = () => Cc["@mozilla.org/security/oskeystore;1"].getService(Ci.nsIOSKeyStore);
  return {
    available: () => keystore().asyncSecretAvailable(label),
    ensureKey: async () => void (await keystore().asyncGenerateSecret(label)),
    encrypt: (plain) => keystore().asyncEncryptBytes(label, Array.from(new TextEncoder().encode(plain))),
    decrypt: async (c) => new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(await keystore().asyncDecryptBytes(label, c))),
  };
}

const notInPackaged = () => {
  if (!dev()) throw new Error("passport test cipher refused in a packaged build");
};

/** Test seam: the key is derived from a fixed string, so an e2e helper writes files a fresh launch reads. */
function memoryCipher(): PassportCipher {
  notInPackaged();
  const key = crypto.subtle
    .digest("SHA-256", new TextEncoder().encode("ressac-passport-dev-key"))
    .then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  return {
    available: async () => true,
    ensureKey: async () => {},
    encrypt: async (plain) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key, new TextEncoder().encode(plain)));
      return b64(iv) + "." + b64(out);
    },
    decrypt: async (c) => {
      const [iv, data] = c.split(".").map((p) => Uint8Array.from(atob(p), (ch) => ch.charCodeAt(0)));
      return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv! }, await key, data!));
    },
  };
}

function absentCipher(): PassportCipher {
  notInPackaged();
  const none = async (): Promise<never> => {
    throw new Error("no passport key");
  };
  return { available: async () => false, ensureKey: none, encrypt: none, decrypt: none };
}
