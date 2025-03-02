import * as argon2 from '@node-rs/argon2';
import winston from 'winston';
import * as xmlJs from 'xml-js';
import * as crypto from 'crypto';
import { promisify } from 'util';
import zlib from 'zlib';
import { CipherData, EncryptedData } from './types';
import { hmacSha256, sha512 } from './hash';
import { deserializeEncryptedData } from './encryptedDataDeserialization';
import { BackupEditTransaction, Secrets, SymmetricKeyGetter } from '../../types';

const decryptCipherData = (cipherData: CipherData, originalKey: Buffer): Buffer => {
    const combinedKey = sha512(originalKey);
    const cipheringKey = combinedKey.slice(0, 32);
    const macKey = combinedKey.slice(32);

    const { iv, hash, encryptedPayload } = cipherData;

    const testSignature = hmacSha256(macKey, Buffer.concat([iv, encryptedPayload]));
    if (testSignature.toString('base64') !== hash.toString('base64')) {
        throw new Error('mismatching signatures');
    }

    const decipher = crypto.createDecipheriv('aes-256-cbc', cipheringKey, iv);
    return Buffer.concat([decipher.update(encryptedPayload), decipher.final()]);
};

export const decrypt = async (encryptedAsBase64: string, symmetricKeyGetter: SymmetricKeyGetter): Promise<Buffer> => {
    const buffer = Buffer.from(encryptedAsBase64, 'base64');
    const decodedBase64 = buffer.toString('ascii');
    const { encryptedData, derivationMethodBytes } = deserializeEncryptedData(decodedBase64, buffer);

    let symmetricKey: Buffer | undefined;
    switch (symmetricKeyGetter.type) {
        case 'alreadyComputed':
            symmetricKey = symmetricKeyGetter.symmetricKey;
            break;
        case 'memoize': {
            let symmetricKeyPromise = symmetricKeyGetter.derivates.get(derivationMethodBytes);
            if (!symmetricKeyPromise) {
                winston.debug(`Computing new derivate with method: ${encryptedData.keyDerivation.algo}`);
                symmetricKeyPromise = getDerivateUsingParametersFromEncryptedData(
                    symmetricKeyGetter.secrets.masterPassword,
                    encryptedData
                );
                symmetricKeyGetter.derivates.set(derivationMethodBytes, symmetricKeyPromise);
            }
            symmetricKey = await symmetricKeyPromise;
        }
    }

    return decryptCipherData(encryptedData.cipherData, symmetricKey);
};

export const decryptTransaction = async <TransactionContent>(
    encryptedTransaction: BackupEditTransaction,
    secrets: Secrets
): Promise<TransactionContent> => {
    const decryptedTransactionContent = await decrypt(encryptedTransaction.content, {
        type: 'alreadyComputed',
        symmetricKey: secrets.localKey,
    });
    const xmlContent = zlib.inflateRawSync(decryptedTransactionContent.slice(6)).toString();
    return JSON.parse(xmlJs.xml2json(xmlContent, { compact: true })) as TransactionContent;
};

export const decryptTransactions = async <TransactionContent>(
    transactions: BackupEditTransaction[],
    secrets: Secrets
): Promise<TransactionContent[]> =>
    Promise.all(transactions.map((transaction) => decryptTransaction<TransactionContent>(transaction, secrets)));

const pbkdf2Async = promisify(crypto.pbkdf2);

export const getDerivateUsingParametersFromEncryptedData = async (
    masterPassword: string,
    cipheringMethod: EncryptedData
): Promise<Buffer> => {
    switch (cipheringMethod.keyDerivation.algo) {
        case 'argon2d':
            return argon2.hashRaw(masterPassword, {
                algorithm: 0,
                timeCost: cipheringMethod.keyDerivation.tCost,
                memoryCost: cipheringMethod.keyDerivation.mCost,
                parallelism: cipheringMethod.keyDerivation.parallelism,
                salt: cipheringMethod.cipherData.salt,
                version: 1, // v19
                outputLen: 32,
            });
        case 'pbkdf2':
            return pbkdf2Async(
                masterPassword,
                cipheringMethod.cipherData.salt,
                cipheringMethod.keyDerivation.iterations,
                32,
                cipheringMethod.keyDerivation.hashMethod
            );
        default:
            throw new Error(
                `Impossible to compute derivate with derivation method '${cipheringMethod.keyDerivation.algo}'`
            );
    }
};
