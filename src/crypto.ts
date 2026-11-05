import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function validateMasterKey(masterKey: string): Buffer {
  if (!/^[a-f0-9]{64}$/i.test(masterKey)) throw new Error('MASTER_KEY must contain 64 hexadecimal characters');
  return Buffer.from(masterKey, 'hex');
}

/** Authenticated encryption binds every secret to its tenant and purpose. */
export function encryptSecret(plaintext: string, masterKey: string, context: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', validateMasterKey(masterKey), nonce);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptSecret(ciphertext: string, masterKey: string, context: string): string {
  const key = validateMasterKey(masterKey);
  try {
    const parts = ciphertext.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1' || parts.slice(1).some(value => !/^[A-Za-z0-9_-]*$/.test(value))) throw new Error();
    const nonce = Buffer.from(parts[1]!, 'base64url');
    const tag = Buffer.from(parts[2]!, 'base64url');
    if (nonce.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, 'base64url')), decipher.final()]).toString('utf8');
  } catch { throw new Error('Stored secret could not be authenticated'); }
}
