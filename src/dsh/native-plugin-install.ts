import { createHash } from 'node:crypto'

export const NATIVE_PLATFORM_INSTALL_PATH = '/api/phalanx/native-plugins/install'
export const NATIVE_PLATFORM_SETTINGS_METHOD = 'phalanx/native-service-settings'
export const NATIVE_PLATFORM_SETTINGS_PATH = '/api/phalanx/native-plugins/settings'
export type NativePlatformActionPath = typeof NATIVE_PLATFORM_INSTALL_PATH | typeof NATIVE_PLATFORM_SETTINGS_PATH
export const NATIVE_INSTALL_PROOF_HEADER = 'x-phalanx-install-proof'
export const NATIVE_INSTALL_SIGNATURE_HEADER = 'x-phalanx-install-signature'
export const NATIVE_INSTALL_LIFETIME_MS = 30000
export const NATIVE_PLUGIN_HISTORY_PATH = '/native-plugin-history'
export const NATIVE_PLUGIN_HISTORY_ENV = 'DSH_PHALANX_NATIVE_PLUGIN_HISTORY_URL'
export interface NativeInstallAuthorization {
  readonly proof: string
  readonly signature: string
}

/** The signed bytes bind the complete native RPC body to one member launch and one action. */
export function nativeInstallProof(
  subject: string,
  generation: string,
  body: string,
  expires: number,
  nonce: string,
  path: NativePlatformActionPath = NATIVE_PLATFORM_INSTALL_PATH,
): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      subject,
      generation,
      nonce,
      expires,
      method: 'POST',
      path,
      digest: createHash('sha256').update(body).digest('hex'),
    }),
  ).toString('base64url')
}

/** One named verifier owns the bounded replay facts for its immutable member generation. */
export const nativeInstallVerifierModule = `import {createHash,createPublicKey,verify} from 'node:crypto';
export function createVerifier(publicKey,subject,generation,now=Date.now) {
  const key=createPublicKey(publicKey);
  const used=new Map();
  return {
    check(authorization,method,path,body) {
      if (!authorization || typeof authorization.proof!=='string' || authorization.proof.length>4096
        || !/^[A-Za-z0-9_-]+$/.test(authorization.proof) || typeof authorization.signature!=='string'
        || !/^[A-Za-z0-9_-]{86}$/.test(authorization.signature) || typeof body!=='string')
        return {ok:false,reason:'proof'};
      let claims;
      try {
        if (!verify(null,Buffer.from(authorization.proof),key,Buffer.from(authorization.signature,'base64url')))
          return {ok:false,reason:'signature'};
        claims=JSON.parse(Buffer.from(authorization.proof,'base64url').toString());
      } catch {
        return {ok:false,reason:'proof'};
      }
      if (!claims || typeof claims!=='object' || Array.isArray(claims) || claims.v!==1
        || Object.keys(claims).some(key=>!['v','subject','generation','nonce','expires','method','path','digest'].includes(key))
        || typeof claims.nonce!=='string' || !/^[A-Za-z0-9_-]{1,120}$/.test(claims.nonce))
        return {ok:false,reason:'proof'};
      if (claims.subject!==subject || claims.generation!==generation || method!=='POST' || claims.method!==method
        || !${JSON.stringify([NATIVE_PLATFORM_INSTALL_PATH, NATIVE_PLATFORM_SETTINGS_PATH])}.includes(path) || claims.path!==path
        || claims.digest!==createHash('sha256').update(body).digest('hex'))
        return {ok:false,reason:'target'};
      const current=now();
      if (!Number.isSafeInteger(current) || !Number.isSafeInteger(claims.expires)
        || claims.expires<=current || claims.expires>current+${NATIVE_INSTALL_LIFETIME_MS})
        return {ok:false,reason:'expired'};
      for (const [nonce,expires] of used) if (expires<=current) used.delete(nonce);
      if (used.has(claims.nonce)) return {ok:false,reason:'replay'};
      if (used.size>=1024) return {ok:false,reason:'busy'};
      used.set(claims.nonce,claims.expires);
      return {ok:true};
    },
  };
}
`
