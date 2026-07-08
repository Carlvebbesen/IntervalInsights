import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { config } from "../config";

/**
 * Symmetric encryption for provider OAuth tokens at rest. AES-GCM via
 * better-auth/crypto, keyed by `TOKEN_ENC_KEY`. Ciphertext is self-describing
 * (versioned envelope) so key rotation is a future concern, not a format change.
 */
export const encryptToken = (plaintext: string): Promise<string> =>
  symmetricEncrypt({ key: config.TOKEN_ENC_KEY, data: plaintext });

export const decryptToken = (ciphertext: string): Promise<string> =>
  symmetricDecrypt({ key: config.TOKEN_ENC_KEY, data: ciphertext });
