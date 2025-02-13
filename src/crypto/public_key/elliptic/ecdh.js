// OpenPGP.js - An OpenPGP implementation in javascript
// Copyright (C) 2015-2016 Decentral
//
// This library is free software; you can redistribute it and/or
// modify it under the terms of the GNU Lesser General Public
// License as published by the Free Software Foundation; either
// version 3.0 of the License, or (at your option) any later version.
//
// This library is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Lesser General Public License for more details.
//
// You should have received a copy of the GNU Lesser General Public
// License along with this library; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301  USA

/**
 * @fileoverview Key encryption and decryption for RFC 6637 ECDH
 * @requires bn.js
 * @requires tweetnacl
 * @requires crypto/public_key/elliptic/curve
 * @requires crypto/aes_kw
 * @requires crypto/cipher
 * @requires crypto/hash
 * @requires type/kdf_params
 * @requires enums
 * @requires util
 * @module crypto/public_key/elliptic/ecdh
 */

import BN from 'bn.js';
import nacl from 'tweetnacl/nacl-fast-light.js';
import Curve from './curves';
import aes_kw from '../../aes_kw';
import cipher from '../../cipher';
import hash from '../../hash';
import type_kdf_params from '../../../type/kdf_params';
import enums from '../../../enums';
import util from '../../../util';

const webCrypto = util.getWebCrypto();
const nodeCrypto = util.getNodeCrypto();

// Build Param for ECDH algorithm (RFC 6637)
function buildEcdhParam(public_algo, oid, cipher_algo, hash_algo, fingerprint) {
  const kdf_params = new type_kdf_params([hash_algo, cipher_algo]);
  return util.concatUint8Array([
    oid.write(),
    new Uint8Array([public_algo]),
    kdf_params.write(),
    util.str_to_Uint8Array("Anonymous Sender    "),
    fingerprint.subarray(0, 20)
  ]);
}

// Key Derivation Function (RFC 6637)
async function kdf(hash_algo, X, length, param, stripLeading = false, stripTrailing = false) {
  // Note: X is little endian for Curve25519, big-endian for all others.
  // This is not ideal, but the RFC's are unclear
  // https://tools.ietf.org/html/draft-ietf-openpgp-rfc4880bis-02#appendix-B
  let i;
  if (stripLeading) {
    // Work around old go crypto bug
    for (i = 0; i < X.length && X[i] === 0; i++);
    X = X.subarray(i);
  }
  if (stripTrailing) {
    // Work around old OpenPGP.js bug
    for (i = X.length - 1; i >= 0 && X[i] === 0; i--);
    X = X.subarray(0, i + 1);
  }
  const digest = await hash.digest(hash_algo, util.concatUint8Array([
    new Uint8Array([0, 0, 0, 1]),
    X,
    param
  ]));
  return digest.subarray(0, length);
}

/**
 * Generate ECDHE ephemeral key and secret from public key
 *
 * @param  {Curve}                  curve        Elliptic curve object
 * @param  {Uint8Array}             Q            Recipient public key
 * @returns {Promise<{publicKey: Uint8Array, sharedKey: Uint8Array}>}
 * @async
 */
async function genPublicEphemeralKey(curve, Q) {
  switch (curve.name) {
    case 'curve25519': {
      const { secretKey: d } = nacl.box.keyPair();
      const { secretKey, sharedKey } = await genPrivateEphemeralKey(curve, Q, null, d);
      let { publicKey } = nacl.box.keyPair.fromSecretKey(secretKey);
      publicKey = util.concatUint8Array([new Uint8Array([0x40]), publicKey]);
      return { publicKey, sharedKey }; // Note: sharedKey is little-endian here, unlike below
    }
    case 'p256':
    case 'p384':
    case 'p521': {
      if (curve.web && util.getWebCrypto()) {
        try {
          return await webPublicEphemeralKey(curve, Q);
        } catch (err) {
          util.print_debug_error(err);
        }
      }
    }
  }
  if (curve.node && nodeCrypto) {
    return nodePublicEphemeralKey(curve, Q);
  }
  return ellipticPublicEphemeralKey(curve, Q);
}

/**
 * Encrypt and wrap a session key
 *
 * @param  {module:type/oid}        oid          Elliptic curve object identifier
 * @param  {module:enums.symmetric} cipher_algo  Symmetric cipher to use
 * @param  {module:enums.hash}      hash_algo    Hash algorithm to use
 * @param  {module:type/mpi}        m            Value derived from session key (RFC 6637)
 * @param  {Uint8Array}             Q            Recipient public key
 * @param  {String}                 fingerprint  Recipient fingerprint
 * @returns {Promise<{publicKey: Uint8Array, wrappedKey: Uint8Array}>}
 * @async
 */
async function encrypt(oid, cipher_algo, hash_algo, m, Q, fingerprint) {
  const curve = new Curve(oid);
  const { publicKey, sharedKey } = await genPublicEphemeralKey(curve, Q);
  const param = buildEcdhParam(enums.publicKey.ecdh, oid, cipher_algo, hash_algo, fingerprint);
  cipher_algo = enums.read(enums.symmetric, cipher_algo);
  const Z = await kdf(hash_algo, sharedKey, cipher[cipher_algo].keySize, param);
  const wrappedKey = aes_kw.wrap(Z, m.toString());
  return { publicKey, wrappedKey };
}

/**
 * Generate ECDHE secret from private key and public part of ephemeral key
 *
 * @param  {Curve}                  curve        Elliptic curve object
 * @param  {Uint8Array}             V            Public part of ephemeral key
 * @param  {Uint8Array}             Q            Recipient public key
 * @param  {Uint8Array}             d            Recipient private key
 * @returns {Promise<{secretKey: Uint8Array, sharedKey: Uint8Array}>}
 * @async
 */
async function genPrivateEphemeralKey(curve, V, Q, d) {
  switch (curve.name) {
    case 'curve25519': {
      const one = new BN(1);
      const mask = one.ushln(255 - 3).sub(one).ushln(3);
      let secretKey = new BN(d);
      secretKey = secretKey.or(one.ushln(255 - 1));
      secretKey = secretKey.and(mask);
      secretKey = secretKey.toArrayLike(Uint8Array, 'le', 32);
      const sharedKey = nacl.scalarMult(secretKey, V.subarray(1));
      return { secretKey, sharedKey }; // Note: sharedKey is little-endian here, unlike below
    }
    case 'p256':
    case 'p384':
    case 'p521': {
      if (curve.web && util.getWebCrypto()) {
        try {
          return await webPrivateEphemeralKey(curve, V, Q, d);
        } catch (err) {
          util.print_debug_error(err);
        }
      }
    }
  }
  if (curve.node && nodeCrypto) {
    return nodePrivateEphemeralKey(curve, V, d);
  }
  return ellipticPrivateEphemeralKey(curve, V, d);
}

/**
 * Decrypt and unwrap the value derived from session key
 *
 * @param  {module:type/oid}        oid          Elliptic curve object identifier
 * @param  {module:enums.symmetric} cipher_algo  Symmetric cipher to use
 * @param  {module:enums.hash}      hash_algo    Hash algorithm to use
 * @param  {Uint8Array}             V            Public part of ephemeral key
 * @param  {Uint8Array}             C            Encrypted and wrapped value derived from session key
 * @param  {Uint8Array}             Q            Recipient public key
 * @param  {Uint8Array}             d            Recipient private key
 * @param  {String}                 fingerprint  Recipient fingerprint
 * @returns {Promise<BN>}                        Value derived from session key
 * @async
 */
async function decrypt(oid, cipher_algo, hash_algo, V, C, Q, d, fingerprint) {
  const curve = new Curve(oid);
  const { sharedKey } = await genPrivateEphemeralKey(curve, V, Q, d);
  const param = buildEcdhParam(enums.publicKey.ecdh, oid, cipher_algo, hash_algo, fingerprint);
  cipher_algo = enums.read(enums.symmetric, cipher_algo);
  let err;
  for (let i = 0; i < 3; i++) {
    try {
      // Work around old go crypto bug and old OpenPGP.js bug, respectively.
      const Z = await kdf(hash_algo, sharedKey, cipher[cipher_algo].keySize, param, i === 1, i === 2);
      return new BN(aes_kw.unwrap(Z, C));
    } catch (e) {
      err = e;
    }
  }
  throw err;
}

/**
 * Generate ECDHE secret from private key and public part of ephemeral key using webCrypto
 *
 * @param  {Curve}                  curve         Elliptic curve object
 * @param  {Uint8Array}             V             Public part of ephemeral key
 * @param  {Uint8Array}             Q             Recipient public key
 * @param  {Uint8Array}             d             Recipient private key
 * @returns {Promise<{secretKey: Uint8Array, sharedKey: Uint8Array}>}
 * @async
 */
async function webPrivateEphemeralKey(curve, V, Q, d) {
  const recipient = privateToJwk(curve.payloadSize, curve.web.web, d, Q);
  let privateKey = webCrypto.importKey(
    "jwk",
    recipient,
    {
      name: "ECDH",
      namedCurve: curve.web.web
    },
    true,
    ["deriveKey", "deriveBits"]
  );
  const jwk = rawPublicToJwk(curve.payloadSize, curve.web.web, V);
  let sender = webCrypto.importKey(
    "jwk",
    jwk,
    {
      name: "ECDH",
      namedCurve: curve.web.web
    },
    true,
    []
  );
  [privateKey, sender] = await Promise.all([privateKey, sender]);
  let S = webCrypto.deriveBits(
    {
      name: "ECDH",
      namedCurve: curve.web.web,
      public: sender
    },
    privateKey,
    curve.web.sharedSize
  );
  let secret = webCrypto.exportKey(
    "jwk",
    privateKey
  );
  [S, secret] = await Promise.all([S, secret]);
  const sharedKey = new Uint8Array(S);
  const secretKey = util.b64_to_Uint8Array(secret.d, true);
  return { secretKey, sharedKey };
}

/**
 * Generate ECDHE ephemeral key and secret from public key using webCrypto
 *
 * @param  {Curve}                  curve        Elliptic curve object
 * @param  {Uint8Array}             Q            Recipient public key
 * @returns {Promise<{publicKey: Uint8Array, sharedKey: Uint8Array}>}
 * @async
 */
async function webPublicEphemeralKey(curve, Q) {
  const jwk = rawPublicToJwk(curve.payloadSize, curve.web.web, Q);
  let keyPair = webCrypto.generateKey(
    {
      name: "ECDH",
      namedCurve: curve.web.web
    },
    true,
    ["deriveKey", "deriveBits"]
  );
  let recipient = webCrypto.importKey(
    "jwk",
    jwk,
    {
      name: "ECDH",
      namedCurve: curve.web.web
    },
    false,
    []
  );
  [keyPair, recipient] = await Promise.all([keyPair, recipient]);
  let s = webCrypto.deriveBits(
    {
      name: "ECDH",
      namedCurve: curve.web.web,
      public: recipient
    },
    keyPair.privateKey,
    curve.web.sharedSize
  );
  let p = webCrypto.exportKey(
    "jwk",
    keyPair.publicKey
  );
  [s, p] = await Promise.all([s, p]);
  const sharedKey = new Uint8Array(s);
  const publicKey = new Uint8Array(jwkToRawPublic(p));
  return { publicKey, sharedKey };
}

/**
 * Generate ECDHE secret from private key and public part of ephemeral key using indutny/elliptic
 *
 * @param  {Curve}                  curve        Elliptic curve object
 * @param  {Uint8Array}             V            Public part of ephemeral key
 * @param  {Uint8Array}             d            Recipient private key
 * @returns {Promise<{secretKey: Uint8Array, sharedKey: Uint8Array}>}
 * @async
 */
async function ellipticPrivateEphemeralKey(curve, V, d) {
  V = curve.keyFromPublic(V);
  d = curve.keyFromPrivate(d);
  const secretKey = new Uint8Array(d.getPrivate());
  const S = d.derive(V);
  const len = curve.curve.curve.p.byteLength();
  const sharedKey = S.toArrayLike(Uint8Array, 'be', len);
  return { secretKey, sharedKey };
}

/**
 * Generate ECDHE ephemeral key and secret from public key using indutny/elliptic
 *
 * @param  {Curve}                  curve        Elliptic curve object
 * @param  {Uint8Array}             Q            Recipient public key
 * @returns {Promise<{publicKey: Uint8Array, sharedKey: Uint8Array}>}
 * @async
 */
async function ellipticPublicEphemeralKey(curve, Q) {
  const v = await curve.genKeyPair();
  Q = curve.keyFromPublic(Q);
  const publicKey = new Uint8Array(v.getPublic());
  const S = v.derive(Q);
  const len = curve.curve.curve.p.byteLength();
  const sharedKey = S.toArrayLike(Uint8Array, 'be', len);
  return { publicKey, sharedKey };
}

/**
 * Generate ECDHE secret from private key and public part of ephemeral key using nodeCrypto
 *
 * @param  {Curve}                  curve          Elliptic curve object
 * @param  {Uint8Array}             V              Public part of ephemeral key
 * @param  {Uint8Array}             d              Recipient private key
 * @returns {Promise<{secretKey: Uint8Array, sharedKey: Uint8Array}>}
 * @async
 */
async function nodePrivateEphemeralKey(curve, V, d) {
  const recipient = nodeCrypto.createECDH(curve.node.node);
  recipient.setPrivateKey(d);
  const sharedKey = new Uint8Array(recipient.computeSecret(V));
  const secretKey = new Uint8Array(recipient.getPrivateKey());
  return { secretKey, sharedKey };
}

/**
 * Generate ECDHE ephemeral key and secret from public key using nodeCrypto
 *
 * @param  {Curve}                  curve        Elliptic curve object
 * @param  {Uint8Array}             Q            Recipient public key
 * @returns {Promise<{publicKey: Uint8Array, sharedKey: Uint8Array}>}
 * @async
 */
async function nodePublicEphemeralKey(curve, Q) {
  const sender = nodeCrypto.createECDH(curve.node.node);
  sender.generateKeys();
  const sharedKey = new Uint8Array(sender.computeSecret(Q));
  const publicKey = new Uint8Array(sender.getPublicKey());
  return { publicKey, sharedKey };
}

/**
 * @param  {Integer}                payloadSize  ec payload size
 * @param  {String}                 name         curve name
 * @param  {Uint8Array}             publicKey    public key
 * @returns {JsonWebKey}                         public key in jwk format
 */
function rawPublicToJwk(payloadSize, name, publicKey) {
  const len = payloadSize;
  const bufX = publicKey.slice(1, len + 1);
  const bufY = publicKey.slice(len + 1, len * 2 + 1);
  // https://www.rfc-editor.org/rfc/rfc7518.txt
  const jwKey = {
    kty: "EC",
    crv: name,
    x: util.Uint8Array_to_b64(bufX, true),
    y: util.Uint8Array_to_b64(bufY, true),
    ext: true
  };
  return jwKey;
}

/**
 * @param  {Integer}                payloadSize  ec payload size
 * @param  {String}                 name         curve name
 * @param  {Uint8Array}             publicKey    public key
 * @param  {Uint8Array}             privateKey   private key
 * @returns {JsonWebKey}                         private key in jwk format
 */
function privateToJwk(payloadSize, name, privateKey, publicKey) {
  const jwk = rawPublicToJwk(payloadSize, name, publicKey);
  jwk.d = util.Uint8Array_to_b64(privateKey, true);
  return jwk;
}

/**
 * @param  {JsonWebKey}                jwk  key for conversion
 * @returns {Uint8Array}                    raw public key
 */
function jwkToRawPublic(jwk) {
  const bufX = util.b64_to_Uint8Array(jwk.x);
  const bufY = util.b64_to_Uint8Array(jwk.y);
  const publicKey = new Uint8Array(bufX.length + bufY.length + 1);
  publicKey[0] = 0x04;
  publicKey.set(bufX, 1);
  publicKey.set(bufY, bufX.length + 1);
  return publicKey;
}

export default { encrypt, decrypt, genPublicEphemeralKey, genPrivateEphemeralKey, buildEcdhParam, kdf, webPublicEphemeralKey, webPrivateEphemeralKey, ellipticPublicEphemeralKey, ellipticPrivateEphemeralKey, nodePublicEphemeralKey, nodePrivateEphemeralKey };
