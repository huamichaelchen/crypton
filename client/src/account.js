/* Crypton Client, Copyright 2013 SpiderOak, Inc.
 *
 * This file is part of Crypton Client.
 *
 * Crypton Client is free software: you can redistribute it and/or modify it
 * under the terms of the Affero GNU General Public License as published by the
 * Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version.
 *
 * Crypton Client is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE.  See the Affero GNU General Public
 * License for more details.
 *
 * You should have received a copy of the Affero GNU General Public License
 * along with Crypton Client.  If not, see <http://www.gnu.org/licenses/>.
*/

(function() {

'use strict';

var MIN_PBKDF2_ROUNDS = 5000;

/**!
 * # Account()
 *
 * ````
 * var account = new crypton.Account();
 * ````
 */
var Account = crypton.Account = function Account () {};

/**!
 * ### save(callback)
 * Send the current account to the server to be saved
 *
 * Calls back without error if successful
 *
 * Calls back with error if unsuccessful
 *
 * @param {Function} callback
 */
Account.prototype.save = function (callback) {
  superagent.post(crypton.url() + '/account')
    .withCredentials()
    .send(this.serialize())
    .end(function (res) {
      if (res.body.success !== true) {
        callback(res.body.error);
      } else {
        callback();
      }
    }
  );
};

/**!
 * ### unravel(callback)
 * Decrypt raw account object from server after successful authentication
 *
 * Calls back without error if successful
 *
 * __Throws__ if unsuccessful
 *
 * @param {Function} callback
 */
Account.prototype.unravel = function (callback) {
  var that = this;

  crypton.work.unravelAccount(this, function (err, data) {
    if (err) {
      return callback(err);
    }

    that.regenerateKeys(data, function (err) {
      callback(err);
    });
  });
};

/**!
 * ### regenerateKeys(callback)
 * Reconstruct keys from unraveled data
 *
 * Calls back without error if successful
 *
 * __Throws__ if unsuccessful
 *
 * @param {Function} callback
 */
Account.prototype.regenerateKeys = function (data, callback) {
  // reconstruct secret key
  var exponent = sjcl.bn.fromBits(data.secret.exponent);
  this.secretKey = new sjcl.ecc.elGamal.secretKey(data.secret.curve, sjcl.ecc.curves['c' + data.secret.curve], exponent);

  // reconstruct public key
  var point = sjcl.ecc.curves['c' + this.pubKey.curve].fromBits(this.pubKey.point);
  this.pubKey = new sjcl.ecc.elGamal.publicKey(this.pubKey.curve, point.curve, point);

  // assign the hmac keys to the account
  this.hmacKey = data.hmacKey;
  this.containerNameHmacKey = data.containerNameHmacKey;

  // reconstruct the public signing key
  var signPoint = sjcl.ecc.curves['c' + this.signKeyPub.curve].fromBits(this.signKeyPub.point);
  this.signKeyPub = new sjcl.ecc.ecdsa.publicKey(this.signKeyPub.curve, signPoint.curve, signPoint);

  // reconstruct the secret signing key
  var signExponent = sjcl.bn.fromBits(data.signKeySecret.exponent);
  this.signKeyPrivate = new sjcl.ecc.ecdsa.secretKey(data.signKeySecret.curve, sjcl.ecc.curves['c' + data.signKeySecret.curve], signExponent);

  // calculate fingerprint for public key
  this.fingerprint = crypton.fingerprint(this.pubKey, this.signKeyPub);

  // recalculate the public points from secret exponents
  // and verify that they match what the server sent us
  var pubKeyHex = sjcl.codec.hex.fromBits(this.pubKey._point.toBits());
  var pubKeyShouldBe = this.secretKey._curve.G.mult(exponent);
  var pubKeyShouldBeHex = sjcl.codec.hex.fromBits(pubKeyShouldBe.toBits());

  if (!crypton.constEqual(pubKeyHex, pubKeyShouldBeHex)) {
    return callback('Server provided incorrect public key');
  }

  var signKeyPubHex = sjcl.codec.hex.fromBits(this.signKeyPub._point.toBits());
  var signKeyPubShouldBe = this.signKeyPrivate._curve.G.mult(signExponent);
  var signKeyPubShouldBeHex = sjcl.codec.hex.fromBits(signKeyPubShouldBe.toBits());

  if (!crypton.constEqual(signKeyPubHex, signKeyPubShouldBeHex)) {
    return callback('Server provided incorrect public signing key');
  }

  // sometimes the account object is used as a peer
  // to make the code simpler. verifyAndDecrypt checks
  // that the peer it is passed is trusted, or returns
  // an error. if we've gotten this far, we can be sure
  // that the public keys are trustable.
  this.trusted = true;

  callback(null);
};

/**!
 * ### serialize()
 * Package and return a JSON representation of the current account
 *
 * @return {Object}
 */
// TODO rename to toJSON
Account.prototype.serialize = function () {
  return {
    srpVerifier: this.srpVerifier,
    srpSalt: this.srpSalt,
    containerNameHmacKeyCiphertext: this.containerNameHmacKeyCiphertext,
    hmacKeyCiphertext: this.hmacKeyCiphertext,
    keypairCiphertext: this.keypairCiphertext,
    keypairMac: this.keypairMac,
    pubKey: this.pubKey,
    keypairSalt: this.keypairSalt,
    keypairMacSalt: this.keypairMacSalt,
    signKeyPrivateMacSalt: this.signKeyPrivateMacSalt,
    username: this.username,
    signKeyPub: this.signKeyPub,
    signKeyPrivateCiphertext: this.signKeyPrivateCiphertext,
    signKeyPrivateMac: this.signKeyPrivateMac
  };
};

/**!
 * ### verifyAndDecrypt()
 * Convienence function to verify and decrypt public key encrypted & signed data
 *
 * @return {Object}
 */
Account.prototype.verifyAndDecrypt = function (signedCiphertext, peer) {
  if (!peer.trusted) {
    return {
      error: 'Peer is untrusted'
    }
  }

  // hash the ciphertext
  var ciphertextString = JSON.stringify(signedCiphertext.ciphertext);
  var hash = sjcl.hash.sha256.hash(ciphertextString);
  // verify the signature
  var verified = false;
  try {
    verified = peer.signKeyPub.verify(hash, signedCiphertext.signature);
  } catch (ex) { }
  // try to decrypt regardless of verification failure
  try {
    var message = sjcl.decrypt(this.secretKey, ciphertextString, crypton.cipherOptions);
    if (verified) {
      return { plaintext: message, verified: verified, error: null };
    } else {
      return { plaintext: null, verified: false, error: 'Cannot verify ciphertext' };
    }
  } catch (ex) {
    return { plaintext: null, verified: false, error: 'Cannot verify ciphertext' };
  }
};

/**!
 * ### changePassword()
 * Convienence function to change the user's password
 *
 * @param {String} oldPassword
 * @param {String} newPassword
 * @param {Function} callback
 * @param {Function} keygenProgressCallback [optional]
 * @param {numRounds} Number [optional] (Integer > 4999)
 * @return void
 */
Account.prototype.changePassword =
  function (oldPassword, newPassword,
            callback, keygenProgressCallback, numRounds) {
  if (oldPassword == newPassword) {
    var err = 'New password cannot be the same as current password';
    return callback(err);
  }

  if (!numRounds) {
    numRounds = MIN_PBKDF2_ROUNDS;
  }
  if (typeof numRounds != 'number') {
    numRounds = MIN_PBKDF2_ROUNDS;
  } else if (numRounds < 5000) {
    numRounds = MIN_PBKDF2_ROUNDS;
  }
  // You can play with numRounds from 5000+,
  // but cannot set numRounds below 5000

  // XXXddahl: check server version mismatch, etc
  if (keygenProgressCallback) {
    if (typeof keygenProgressCallback == 'function') {
      keygenProgressCallback();
    }
  }

  // Replace all salts with new ones
  var keypairSalt = randomBytes(32);
  var keypairMacSalt = randomBytes(32);
  var signKeyPrivateMacSalt = randomBytes(32);

  var keypairKey =
    sjcl.misc.pbkdf2(newPassword, keypairSalt, numRounds);

  var keypairMacKey =
    sjcl.misc.pbkdf2(newPassword, keypairMacSalt, numRounds);

  var signKeyPrivateMacKey =
    sjcl.misc.pbkdf2(newPassword, signKeyPrivateMacSalt, numRounds);

  // Re-encrypt the stored keyring

  var tmpAcct = {};

  tmpAcct.signKeyPrivateCiphertext =
    sjcl.encrypt(keypairKey,
                 JSON.stringify(this.signingKeys.sec.serialize()),
                 crypton.cipherOptions);

  tmpAcct.signKeyPrivateMac = crypton.hmac(signKeyPrivateMacKey,
                                           this.signKeyPrivateCiphertext);

  var wrappingJWK = this.makeJWK('wrappingKey', { keyArray: keypairKey,
                                                  salt: keypairSalt,
                                                  numRounds: numRounds});
  if (!wrappingJWK) {
    return callback('Cannot generate wrappingJWK');
  }
  // save existing account data into new JSON string
  var originalAcct = this.serialize();

  // Set the new properties of the account before we save
  tmpAcct.keypairKey = keypairKey;
  tmpAcct.keypairSalt = keypairSalt;
  tmpAcct.keypairMacKey = keypairMacKey;
  tmpAcct.keypairMacSalt = keypairMacSalt;
  tmpAcct.signKeyPrivateMacKey = signKeyPrivateMacKey;
  tmpAcct.signKeyPrivateMacSalt = signKeyPrivateMacSalt;

  var keypairCiphertext =
    sjcl.encrypt(wrappingJWK,
                 JSON.stringify(this.keypair.sec.serialize()),
                 crypton.cipherOptions);

  tmpAcct.keypairCiphertext = numRounds
                            + '__key__'
                            + JSON.stringify(keypairCiphertext);

  tmpAcct.keypairMac =
    crypton.hmac(keypairMacKey, tmpAcct.keypairCiphertext);

  for (var prop in tmpAcct) {
    this[prop] = tmpAcct[prop];
  }

  this.save(function (err) {
    if (err) {
      // The acount save failed, but we still have the original data yet
      // Revert back to what we had before the process started...
      var origAcctObj = JSON.parse(originalAcct);
      for (var prop in tmpAcct) {
        this[prop] = origAcctObj[prop];
      }
      callback(err, this);
    }
    callback(null, this);
  });
};

/**!
 * ### changePassword()
 * Convienence function to change the user's password
 *
 * When using this function you must check for null result to know it failed
 *
 * See: http://tools.ietf.org/html/draft-ietf-jose-json-web-key-31#appendix-A.3
 *
 * @param {String} keyType
 * @param {Object} values
 * @return {Object}
 */
Account.prototype.makeJWK = function (keyType, values) {
  var KEYPAIR_KEY = 'wrappingKey';

  if (typeof values != 'object' || typeof keyType != 'string') {
    console.error('makeJWK: Illegal arguments');
    return null;
  }

  var keypairKeyObj = {
    kty: 'PBES2', // 'PBKDF2-HMAC-SHA256'
    use: 'enc',
    key_ops: ['wrap_key', 'unwrap_key'],
    p2s: null, // salt
    alg: 'PBES2-HS256+A128KW', // XXXddahl: not sure if the spec works for SJCL PBKDF2 alg of 'PBKDF2-HMAC-SHA256'??
    p2c: 5000, // 'num rounds' or 'count' of PBKDF2 iterations
    kid: 'key wrapping key',
    k: null
  };

  switch (keyType) {
    case KEYPAIR_KEY:
    // Check for required values
    if (!values.salt || !values.keyArray || !values.numRounds) {
      console.error('makeJWK: values object missing salt, keyArray or numRounds');
      return null;
    }
    // Type check the values
    if (!(typeof values.salt == 'string')) {
      console.error('makeJWK: values.salt is not a string!');
      return null;
    }
    if (!(typeof values.keyArray == 'object')) { // Actually an array
      console.error('makeJWK: values.keyArray is not an array!');
      return null;
    }
    if (!(typeof values.numRounds == 'number')) {
      console.error('makeJWK: values.numRounds is not a number!');
      return null;
    }
    // Add salt and base64'd key data to keypairKeyObj
    var base64Key = btoa(JSON.stringify(values.keyArray));
    keypairKeyObj.k = base64Key;
    keypairKeyObj.p2c = values.numRounds;
    keypairKeyObj.p2s = values.salt;
    return keypairKeyObj;

    default:
    return null;
  }
};
})();
