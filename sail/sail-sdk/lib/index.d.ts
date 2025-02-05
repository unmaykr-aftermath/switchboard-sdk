/**
 * Class for handling EnclaveKeys operations.
 */
export class EnclaveKeys {
  /**
   * Gets the AMD-SEV runtime derived key.
   * @returns A `Uint8Array` containing the derived key.
   */
  getDerivedKey(): Uint8Array;

  /**
   * Retrieves an Ed25519 keypair.
   * @returns A `Uint8Array` containing the Ed25519 keypair.
   */
  getEnclaveEd25519Keypair(): Uint8Array;

  /**
   * Retrieves a Secp256k1 keypair.
   * @returns A `Uint8Array` containing the Secp256k1 keypair.
   */
  getEnclaveSecp256k1Keypair(): Uint8Array;
}

/**
 * Class for handling AMD SEV-SNP attestation operations.
 */
export class AmdSevSnpAttestation {
  /**
   * Generates an attestation report for a given message.
   * @param message - The message to be included in the attestation report.
   * @returns A `Promise<Uint8Array>` containing the attestation report.
   */
  attest(message: Uint8Array): Promise<Uint8Array>;

  /**
   * Verifies an attestation report and an optional message.
   * @param report - The attestation report to verify.
   * @param message - An optional message to verify against the report.
   * @returns A `Promise<void>` resolving if verification succeeds.
   */
  verify(report: Uint8Array, message?: Uint8Array): Promise<void>;
}

/**
 * Class for generating randomness.
 */
export class TeeRandomness {
  /**
   * Generates random bytes.
   * @param numBytes - The number of random bytes to generate.
   * @returns A `Uint8Array` containing the random bytes.
   */
  readRand(numBytes: number): Uint8Array;
}
