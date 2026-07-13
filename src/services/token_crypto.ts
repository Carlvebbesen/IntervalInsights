import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { config } from "../config";

export const encryptToken = (plaintext: string): Promise<string> =>
  symmetricEncrypt({ key: config.TOKEN_ENC_KEY, data: plaintext });

export const decryptToken = (ciphertext: string): Promise<string> =>
  symmetricDecrypt({ key: config.TOKEN_ENC_KEY, data: ciphertext });
