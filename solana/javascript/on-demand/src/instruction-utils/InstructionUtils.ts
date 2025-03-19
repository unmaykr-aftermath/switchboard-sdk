import { web3 } from '@coral-xyz/anchor-30';

/*
 * Utilities namespace for instruction related functions
 * */
export class InstructionUtils {
  /**
   *  Disable instantiation of the InstructionUtils class
   */
  private constructor() {}
  /**
   * Function to convert transaction instructions to a versioned transaction.
   *
   * @param {object} params - The parameters object.
   * @param {web3.Connection} params.connection - The connection to use.
   * @param {web3.TransactionInstruction[]} params.ixs - The transaction instructions.
   * @param {web3.PublicKey} [params.payer] - The payer for the transaction.
   * @param {number} [params.computeUnitLimitMultiple] - The compute units to cap the transaction as a multiple of the simulated units consumed (e.g., 1.25x).
   * @param {number} [params.computeUnitPrice] - The price per compute unit in microlamports.
   * @param {web3.AddressLookupTableAccount[]} [params.lookupTables] - The address lookup tables.
   * @param {web3.Signer[]} [params.signers] - The signers for the transaction.
   * @returns {Promise<web3.VersionedTransaction>} A promise that resolves to the versioned transaction.
   */
  static async asV0TxWithComputeIxs(params: {
    connection: web3.Connection;
    ixs: web3.TransactionInstruction[];
    payer?: web3.PublicKey;
    computeUnitLimitMultiple?: number;
    computeUnitPrice?: number;
    lookupTables?: web3.AddressLookupTableAccount[];
    signers?: web3.Signer[];
  }): Promise<web3.VersionedTransaction> {
    let payer = params.payer;
    if (!payer) {
      if (!params.signers?.length) {
        throw new Error('Payer not provided');
      }
      payer = params.signers[0].publicKey;
    }
    const priorityFeeIx = web3.ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: params.computeUnitPrice ?? 0,
    });
    const simulationComputeLimitIx =
      web3.ComputeBudgetProgram.setComputeUnitLimit({
        units: 1_400_000, // 1.4M compute units
      });
    const recentBlockhash = (await params.connection.getLatestBlockhash())
      .blockhash;

    const simulateMessageV0 = new web3.TransactionMessage({
      recentBlockhash,
      instructions: [...params.ixs, priorityFeeIx, simulationComputeLimitIx],
      payerKey: payer,
    }).compileToV0Message(params.lookupTables ?? []);
    const simulateTx = new web3.VersionedTransaction(simulateMessageV0);
    try {
      simulateTx.serialize();
    } catch (e) {
      if (e instanceof RangeError) {
        throw new Error(
          'Transaction failed to serialize: Transaction too large'
        );
      }
      throw e;
    }
    const simulationResult = await params.connection.simulateTransaction(
      simulateTx,
      { commitment: 'processed', sigVerify: false }
    );

    const simulationUnitsConsumed = simulationResult.value.unitsConsumed!;
    const computeLimitIx = web3.ComputeBudgetProgram.setComputeUnitLimit({
      units: Math.floor(
        simulationUnitsConsumed * (params.computeUnitLimitMultiple ?? 1)
      ),
    });
    const messageV0 = new web3.TransactionMessage({
      recentBlockhash,
      instructions: [...params.ixs, priorityFeeIx, computeLimitIx],
      payerKey: payer,
    }).compileToV0Message(params.lookupTables ?? []);
    const tx = new web3.VersionedTransaction(messageV0);
    tx.sign(params.signers ?? []);
    return tx;
  }
}
