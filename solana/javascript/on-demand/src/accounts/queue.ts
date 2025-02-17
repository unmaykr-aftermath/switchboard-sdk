import {
  SOL_NATIVE_MINT,
  SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
} from "../constants.js";
import type {
  FeedEvalResponse,
  FetchSignaturesBatchResponse,
  FetchSignaturesConsensusResponse,
  FetchSignaturesMultiResponse,
} from "../oracle-interfaces/gateway.js";
import { Gateway } from "../oracle-interfaces/gateway.js";
import {
  isMainnetConnection,
  ON_DEMAND_DEVNET_PID,
  ON_DEMAND_MAINNET_PID,
} from "../utils";

import * as spl from "./../utils/index.js";
import type { SwitchboardPermission } from "./permission.js";
import { Permission } from "./permission.js";
import type { FeedRequest } from "./pullFeed.js";
import { State } from "./state.js";

import type { Program } from "@coral-xyz/anchor";
import { BN, BorshAccountsCoder, utils, web3 } from "@coral-xyz/anchor";
import type { IOracleJob } from "@switchboard-xyz/common";
import { Buffer } from "buffer";

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | null> {
  // Create a timeout promise that resolves to null after timeoutMs milliseconds
  const timeoutPromise = new Promise<null>((resolve) =>
    setTimeout(resolve, timeoutMs, null)
  );

  // Race the timeout promise against the original promise
  return Promise.race([promise, timeoutPromise]);
}
/**
 *  Removes trailing null bytes from a string.
 *
 *  @param input The input string.
 *  @returns The input string with trailing null bytes removed.
 */
function removeTrailingNullBytes(input: string): string {
  // Regular expression to match trailing null bytes
  const trailingNullBytesRegex = /\x00+$/;
  // Remove trailing null bytes using the replace() method
  return input.replace(trailingNullBytesRegex, "");
}

function runWithTimeout<T>(
  task: Promise<T>,
  timeoutMs: number
): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    // Set up the timeout
    const timer = setTimeout(() => {
      resolve("timeout");
    }, timeoutMs);

    task.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 *  Abstraction around the Switchboard-On-Demand Queue account
 *
 *  This account is used to store the queue data for a given feed.
 */
export class Queue {
  static async createIx(
    program: Program,
    params: {
      allowAuthorityOverrideAfter?: number;
      requireAuthorityHeartbeatPermission?: boolean;
      requireUsagePermission?: boolean;
      maxQuoteVerificationAge?: number;
      reward?: number;
      nodeTimeout?: number;
      lutSlot?: number;
    }
  ): Promise<[Queue, web3.Keypair, web3.TransactionInstruction]> {
    const stateKey = State.keyFromSeed(program);
    const state = await State.loadData(program);
    const queue = web3.Keypair.generate();
    const allowAuthorityOverrideAfter =
      params.allowAuthorityOverrideAfter ?? 60 * 60;
    const requireAuthorityHeartbeatPermission =
      params.requireAuthorityHeartbeatPermission ?? true;
    const requireUsagePermission = params.requireUsagePermission ?? false;
    const maxQuoteVerificationAge =
      params.maxQuoteVerificationAge ?? 60 * 60 * 24 * 7;
    const reward = params.reward ?? 1000000;
    const nodeTimeout = params.nodeTimeout ?? 300;
    const payer = (program.provider as any).wallet.payer;
    // Prepare accounts for the transaction
    const lutSigner = (
      await web3.PublicKey.findProgramAddress(
        [Buffer.from("LutSigner"), queue.publicKey.toBuffer()],
        program.programId
      )
    )[0];
    const [delegationGroup] = await web3.PublicKey.findProgramAddress(
      [
        Buffer.from("Group"),
        stateKey.toBuffer(),
        state.stakePool.toBuffer(),
        queue.publicKey.toBuffer(),
      ],
      state.stakeProgram
    );
    const recentSlot =
      params.lutSlot ??
      (await program.provider.connection.getSlot("finalized"));
    const [_, lut] = web3.AddressLookupTableProgram.createLookupTable({
      authority: lutSigner,
      payer: payer.publicKey,
      recentSlot,
    });

    let stakePool = state.stakePool;
    if (stakePool.equals(web3.PublicKey.default)) {
      stakePool = payer.publicKey;
    }
    const queueAccount = new Queue(program, queue.publicKey);
    const ix = await program.instruction.queueInit(
      {
        allowAuthorityOverrideAfter,
        requireAuthorityHeartbeatPermission,
        requireUsagePermission,
        maxQuoteVerificationAge,
        reward,
        nodeTimeout,
        recentSlot: new BN(recentSlot),
      },
      {
        accounts: {
          queue: queue.publicKey,
          queueEscrow: await spl.getAssociatedTokenAddress(
            SOL_NATIVE_MINT,
            queue.publicKey
          ),
          authority: payer.publicKey,
          payer: payer.publicKey,
          systemProgram: web3.SystemProgram.programId,
          tokenProgram: SPL_TOKEN_PROGRAM_ID,
          nativeMint: SOL_NATIVE_MINT,
          programState: State.keyFromSeed(program),
          lutSigner: await queueAccount.lutSigner(),
          lut: await queueAccount.lutKey(recentSlot),
          addressLookupTableProgram: web3.AddressLookupTableProgram.programId,
          delegationGroup,
          stakeProgram: state.stakeProgram,
          stakePool: stakePool,
          associatedTokenProgram: SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
        },
        signers: [payer, queue],
      }
    );
    return [new Queue(program, queue.publicKey), queue, ix];
  }

  /**
   * Creates a new instance of the `Queue` account with a PDA for SVM (non-solana) chains.
   * @param program The anchor program instance.
   * @param params The initialization parameters for the queue.
   * @returns
   */
  static async createIxSVM(
    program: Program,
    params: {
      sourceQueueKey: web3.PublicKey;
      allowAuthorityOverrideAfter?: number;
      requireAuthorityHeartbeatPermission?: boolean;
      requireUsagePermission?: boolean;
      maxQuoteVerificationAge?: number;
      reward?: number;
      nodeTimeout?: number;
      lutSlot?: number;
    }
  ): Promise<[Queue, web3.TransactionInstruction]> {
    const stateKey = State.keyFromSeed(program);
    const state = await State.loadData(program);

    // Generate the queue PDA for the given source queue key
    const [queue] = await web3.PublicKey.findProgramAddress(
      [Buffer.from("Queue"), params.sourceQueueKey.toBuffer()],
      program.programId
    );
    const allowAuthorityOverrideAfter =
      params.allowAuthorityOverrideAfter ?? 60 * 60;
    const requireAuthorityHeartbeatPermission =
      params.requireAuthorityHeartbeatPermission ?? true;
    const requireUsagePermission = params.requireUsagePermission ?? false;
    const maxQuoteVerificationAge =
      params.maxQuoteVerificationAge ?? 60 * 60 * 24 * 7;
    const reward = params.reward ?? 1000000;
    const nodeTimeout = params.nodeTimeout ?? 300;
    const payer = (program.provider as any).wallet.payer;
    // Prepare accounts for the transaction
    const lutSigner = (
      await web3.PublicKey.findProgramAddress(
        [Buffer.from("LutSigner"), queue.toBuffer()],
        program.programId
      )
    )[0];
    const [delegationGroup] = await web3.PublicKey.findProgramAddress(
      [
        Buffer.from("Group"),
        stateKey.toBuffer(),
        state.stakePool.toBuffer(),
        queue.toBuffer(),
      ],
      state.stakeProgram
    );
    const recentSlot =
      params.lutSlot ??
      (await program.provider.connection.getSlot("finalized"));
    const [_, lut] = web3.AddressLookupTableProgram.createLookupTable({
      authority: lutSigner,
      payer: payer.publicKey,
      recentSlot,
    });

    let stakePool = state.stakePool;
    if (stakePool.equals(web3.PublicKey.default)) {
      stakePool = payer.publicKey;
    }
    const queueAccount = new Queue(program, queue);
    const ix = program.instruction.queueInitSvm(
      {
        allowAuthorityOverrideAfter,
        requireAuthorityHeartbeatPermission,
        requireUsagePermission,
        maxQuoteVerificationAge,
        reward,
        nodeTimeout,
        recentSlot: new BN(recentSlot),
        sourceQueueKey: params.sourceQueueKey,
      },
      {
        accounts: {
          queue: queue,
          queueEscrow: await spl.getAssociatedTokenAddress(
            SOL_NATIVE_MINT,
            queue,
            true
          ),
          authority: payer.publicKey,
          payer: payer.publicKey,
          systemProgram: web3.SystemProgram.programId,
          tokenProgram: SPL_TOKEN_PROGRAM_ID,
          nativeMint: SOL_NATIVE_MINT,
          programState: State.keyFromSeed(program),
          lutSigner: await queueAccount.lutSigner(),
          lut: await queueAccount.lutKey(recentSlot),
          addressLookupTableProgram: web3.AddressLookupTableProgram.programId,
          delegationGroup,
          stakeProgram: state.stakeProgram,
          stakePool: stakePool,
          associatedTokenProgram: SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
        },
        signers: [payer],
      }
    );
    return [new Queue(program, queue), ix];
  }

  /**
   * Add an Oracle to a queue and set permissions
   * @param program
   * @param params
   */
  async overrideSVM(params: {
    oracle: web3.PublicKey;
    secp256k1Signer: Buffer;
    maxQuoteVerificationAge: number;
    mrEnclave: Buffer;
    slot: number;
  }) {
    const stateKey = State.keyFromSeed(this.program);
    const state = await State.loadData(this.program);
    const programAuthority = state.authority;
    const { authority } = await this.loadData();

    const ix = this.program.instruction.queueOverrideSvm(
      {
        secp256K1Signer: Array.from(params.secp256k1Signer),
        maxQuoteVerificationAge: new BN(params.maxQuoteVerificationAge),
        mrEnclave: params.mrEnclave,
        slot: new BN(params.slot),
      },
      {
        accounts: {
          queue: this.pubkey,
          oracle: params.oracle,
          authority,
          state: stateKey,
        },
      }
    );
    return ix;
  }

  async initDelegationGroupIx(params: {
    lutSlot?: number;
    overrideStakePool?: web3.PublicKey;
  }): Promise<web3.TransactionInstruction> {
    const queueAccount = new Queue(this.program, this.pubkey);
    const lutSlot = params.lutSlot ?? (await this.loadData()).lutSlot;
    const payer = (this.program.provider as any).wallet.payer;
    const stateKey = State.keyFromSeed(this.program);
    const state = await State.loadData(this.program);
    const stakePool = params.overrideStakePool ?? state.stakePool;
    const [delegationGroup] = await web3.PublicKey.findProgramAddress(
      [
        Buffer.from("Group"),
        stateKey.toBuffer(),
        stakePool.toBuffer(),
        this.pubkey.toBuffer(),
      ],
      state.stakeProgram
    );
    const isMainnet = isMainnetConnection(this.program.provider.connection);
    let pid = ON_DEMAND_MAINNET_PID;
    if (!isMainnet) {
      pid = ON_DEMAND_DEVNET_PID;
    }
    const [queueEscrowSigner] = await web3.PublicKey.findProgramAddress(
      [Buffer.from("Signer"), this.pubkey.toBuffer()],
      pid
    );
    const ix = await this.program.instruction.queueInitDelegationGroup(
      {},
      {
        accounts: {
          queue: this.pubkey,
          queueEscrow: await spl.getAssociatedTokenAddress(
            SOL_NATIVE_MINT,
            this.pubkey
          ),
          queueEscrowSigner,
          payer: payer.publicKey,
          systemProgram: web3.SystemProgram.programId,
          tokenProgram: SPL_TOKEN_PROGRAM_ID,
          nativeMint: SOL_NATIVE_MINT,
          programState: stateKey,
          lutSigner: await this.lutSigner(),
          lut: await this.lutKey(lutSlot),
          addressLookupTableProgram: web3.AddressLookupTableProgram.programId,
          delegationGroup: delegationGroup,
          stakeProgram: state.stakeProgram,
          stakePool: stakePool,
        },
      }
    );
    return ix;
  }

  /**
   *  Fetches signatures from a random gateway on the queue.
   *
   *  REST API endpoint: /api/v1/fetch_signatures
   *
   *  @param recentHash The chain metadata to sign with. Blockhash or slothash.
   *  @param jobs The oracle jobs to perform.
   *  @param numSignatures The number of oracles to fetch signatures from.
   *  @returns A promise that resolves to the feed evaluation responses.
   *  @throws if the request fails.
   */
  static async fetchSignatures(
    program: Program,
    params: {
      gateway?: string;
      queue: web3.PublicKey;
      recentHash?: string;
      jobs: IOracleJob[];
      numSignatures?: number;
      maxVariance?: number;
      minResponses?: number;
    }
  ): Promise<{ responses: FeedEvalResponse[]; failures: string[] }> {
    const queueAccount = new Queue(program, params.queue);
    return queueAccount.fetchSignatures(params);
  }

  static async fetchSignaturesMulti(
    program: Program,
    params: {
      gateway?: string;
      queue: web3.PublicKey;
      recentHash?: string;
      feedConfigs: FeedRequest[];
      minResponses?: number;
    }
  ): Promise<FetchSignaturesMultiResponse> {
    const queueAccount = new Queue(program, params.queue!);
    return queueAccount.fetchSignaturesMulti(params);
  }

  static async fetchSignaturesBatch(
    program: Program,
    params: {
      gateway?: string;
      queue: web3.PublicKey;
      recentHash?: string;
      feedConfigs: FeedRequest[];
      minResponses?: number;
    }
  ): Promise<FetchSignaturesBatchResponse> {
    const queueAccount = new Queue(program, params.queue!);
    return queueAccount.fetchSignaturesBatch(params);
  }

  static async fetchSignaturesConsensus(
    program: Program,
    params: {
      gateway?: string;
      queue: web3.PublicKey;
      recentHash?: string;
      feedConfigs: FeedRequest[];
      useTimestamp?: boolean;
      numSignatures?: number;
    }
  ): Promise<FetchSignaturesConsensusResponse> {
    const queueAccount = new Queue(program, params.queue!);
    return queueAccount.fetchSignaturesConsensus({
      gateway: params.gateway,
      recentHash: params.recentHash,
      feedConfigs: params.feedConfigs,
      useTimestamp: params.useTimestamp,
      numSignatures: params.numSignatures,
    });
  }

  /**
   * @deprecated
   * Deprecated. Use {@linkcode @switchboard-xyz/common#FeedHash.compute} instead.
   */
  static async fetchFeedHash(
    program: Program,
    params: {
      gateway?: string;
      queue: web3.PublicKey;
      recentHash?: string;
      jobs: IOracleJob[];
      numSignatures?: number;
      maxVariance?: number;
      minResponses?: number;
    }
  ): Promise<Buffer> {
    const queueAccount = new Queue(program, params.queue);
    const oracleSigs = await queueAccount.fetchSignatures(params);
    return Buffer.from(oracleSigs[0].feed_hash, "hex");
  }

  /**
   *  Constructs a `OnDemandQueue` instance.
   *
   *  @param program The Anchor program instance.
   *  @param pubkey The public key of the queue account.
   */
  constructor(readonly program: Program, readonly pubkey: web3.PublicKey) {
    if (this.pubkey === undefined) {
      throw new Error("NoPubkeyProvided");
    }
  }

  /**
   *  Loads the queue data from on chain and returns the listed oracle keys.
   *
   *  @returns A promise that resolves to an array of oracle public keys.
   */
  async fetchOracleKeys(): Promise<web3.PublicKey[]> {
    const program = this.program;
    const queueData = (await program.account["queueAccountData"].fetch(
      this.pubkey
    )) as any;
    const oracles = queueData.oracleKeys.slice(0, queueData.oracleKeysLen);
    return oracles;
  }

  /**
   *  Loads the queue data from on chain and returns the listed gateways.
   *
   *  @returns A promise that resolves to an array of gateway URIs.
   */
  async fetchAllGateways(): Promise<Gateway[]> {
    const queue = this.pubkey;
    const program = this.program;
    const coder = new BorshAccountsCoder(program.idl);
    const oracles = await this.fetchOracleKeys();
    const oracleAccounts = await utils.rpc.getMultipleAccounts(
      program.provider.connection,
      oracles
    );
    const gatewayUris = oracleAccounts
      .map((x: any) => coder.decode("oracleAccountData", x.account.data))
      .map((x: any) => String.fromCharCode(...x.gatewayUri))
      .map((x: string) => removeTrailingNullBytes(x))
      .filter((x: string) => x.length > 0)
      .filter((x: string) => !x.includes("infstones"));

    const tests: Promise<boolean>[] = [];
    for (const i in gatewayUris) {
      const gw = new Gateway(program, gatewayUris[i], oracles[i]);
      tests.push(gw.test());
    }

    let gateways: Gateway[] = [];
    for (let i = 0; i < tests.length; i++) {
      try {
        const isGood = await withTimeout(tests[i], 2000);
        if (isGood) {
          gateways.push(new Gateway(program, gatewayUris[i], oracles[i]));
        }
      } catch (e) {
        console.log("Timeout", e);
      }
    }
    gateways = gateways.sort(() => Math.random() - 0.5);
    return gateways as Gateway[];
  }

  /**
   * Fetches a gateway interface for interacting with oracle nodes.
   *
   * @param gatewayUrl - Optional URL of a specific gateway to use. If not provided,
   *                     a random gateway will be selected from the queue's available gateways.
   * @returns Gateway - A Gateway instance for making oracle requests
   * @throws {Error} If no gateways are available on the queue when selecting randomly
   */
  async fetchGateway(gatewayUrl?: string): Promise<Gateway> {
    if (gatewayUrl) return new Gateway(this.program, gatewayUrl);

    const gateways = await this.fetchAllGateways();
    if (gateways.length === 0) throw new Error("NoGatewayAvailable");
    return gateways[Math.floor(Math.random() * gateways.length)];
  }

  /**
   *  Fetches signatures from a random gateway on the queue.
   *
   *  REST API endpoint: /api/v1/fetch_signatures
   *
   *  @param gateway The gateway to fetch signatures from. If not provided, a gateway will be automatically selected.
   *  @param recentHash The chain metadata to sign with. Blockhash or slothash.
   *  @param jobs The oracle jobs to perform.
   *  @param numSignatures The number of oracles to fetch signatures from.
   *  @param maxVariance The maximum variance allowed in the responses.
   *  @param minResponses The minimum number of responses to attempt to fetch.
   *  @returns A promise that resolves to the feed evaluation responses.
   *  @throws if the request fails.
   */
  async fetchSignatures(params: {
    gateway?: string;
    recentHash?: string;
    jobs: IOracleJob[];
    numSignatures?: number;
    maxVariance?: number;
    minResponses?: number;
    useTimestamp?: boolean;
  }): Promise<{ responses: FeedEvalResponse[]; failures: string[] }> {
    const gateway = await this.fetchGateway(params.gateway);
    return await gateway.fetchSignatures({
      recentHash: params.recentHash,
      jobs: params.jobs,
      numSignatures: params.numSignatures,
      maxVariance: params.maxVariance,
      minResponses: params.minResponses,
      useTimestamp: params.useTimestamp,
    });
  }

  async fetchSignaturesMulti(params: {
    gateway?: string;
    recentHash?: string;
    feedConfigs: FeedRequest[];
    numSignatures?: number;
    useTimestamp?: boolean;
  }): Promise<FetchSignaturesMultiResponse> {
    const gateway = await this.fetchGateway(params.gateway);
    return await gateway.fetchSignaturesMulti({
      recentHash: params.recentHash,
      feedConfigs: params.feedConfigs,
      numSignatures: params.numSignatures,
      useTimestamp: params.useTimestamp,
    });
  }

  async fetchSignaturesConsensus(params: {
    gateway?: string;
    recentHash?: string;
    feedConfigs: FeedRequest[];
    useTimestamp?: boolean;
    numSignatures?: number;
  }): Promise<FetchSignaturesConsensusResponse> {
    const gateway = await this.fetchGateway(params.gateway);
    return await gateway.fetchSignaturesConsensus({
      recentHash: params.recentHash,
      feedConfigs: params.feedConfigs,
      useTimestamp: params.useTimestamp,
      numSignatures: params.numSignatures,
    });
  }

  async fetchSignaturesBatch(params: {
    gateway?: string;
    recentHash?: string;
    feedConfigs: FeedRequest[];
    numSignatures?: number;
    useTimestamp?: boolean;
  }): Promise<FetchSignaturesBatchResponse> {
    const gateway = await this.fetchGateway(params.gateway);
    return await gateway.fetchSignaturesBatch({
      recentHash: params.recentHash,
      feedConfigs: params.feedConfigs,
      numSignatures: params.numSignatures,
      useTimestamp: params.useTimestamp,
    });
  }

  /**
   *  Loads the queue data for this {@linkcode Queue} account from on chain.
   *
   *  @returns A promise that resolves to the queue data.
   *  @throws if the queue account does not exist.
   */
  static loadData(program: Program, pubkey: web3.PublicKey): Promise<any> {
    return program.account["queueAccountData"].fetch(pubkey);
  }

  /**
   *  Loads the queue data for this {@linkcode Queue} account from on chain.
   *
   *  @returns A promise that resolves to the queue data.
   *  @throws if the queue account does not exist.
   */
  async loadData(): Promise<any> {
    return await Queue.loadData(this.program, this.pubkey);
  }

  /**
   *  Adds a new MR enclave to the queue.
   *  This will allow the queue to accept signatures from the given MR enclave.
   *  @param mrEnclave The MR enclave to add.
   *  @returns A promise that resolves to the transaction instruction.
   *  @throws if the request fails.
   *  @throws if the MR enclave is already added.
   *  @throws if the MR enclave is invalid.
   *  @throws if the MR enclave is not a valid length.
   */
  async addMrEnclaveIx(params: {
    mrEnclave: Uint8Array;
  }): Promise<web3.TransactionInstruction> {
    const stateKey = State.keyFromSeed(this.program);
    const state = await State.loadData(this.program);
    const programAuthority = state.authority;
    const { authority } = await this.loadData();
    const ix = await this.program.instruction.queueAddMrEnclave(
      { mrEnclave: params.mrEnclave },
      {
        accounts: {
          queue: this.pubkey,
          authority,
          programAuthority,
          state: stateKey,
        },
      }
    );
    return ix;
  }

  /**
   *  Removes an MR enclave from the queue.
   *  This will prevent the queue from accepting signatures from the given MR enclave.
   *  @param mrEnclave The MR enclave to remove.
   *  @returns A promise that resolves to the transaction instruction.
   *  @throws if the request fails.
   *  @throws if the MR enclave is not present.
   */
  async rmMrEnclaveIx(params: {
    mrEnclave: Uint8Array;
  }): Promise<web3.TransactionInstruction> {
    const stateKey = State.keyFromSeed(this.program);
    const state = await State.loadData(this.program);
    const programAuthority = state.authority;
    const { authority } = await this.loadData();
    const ix = await this.program.instruction.queueRemoveMrEnclave(
      { mrEnclave: params.mrEnclave },
      {
        accounts: {
          queue: this.pubkey,
          authority,
          programAuthority,
          state: stateKey,
        },
      }
    );
    return ix;
  }

  /**
   * Sets the queue configurations.
   * @param params.authority The new authority for the queue.
   * @param params.reward The new reward for the queue.
   * @param params.nodeTimeout The new node timeout for the queue.
   * @returns A promise that resolves to the transaction instruction.
   */
  async setConfigsIx(params: {
    authority?: web3.PublicKey;
    reward?: number;
    nodeTimeout?: number;
  }): Promise<web3.TransactionInstruction> {
    const data = await this.loadData();
    const stateKey = State.keyFromSeed(this.program);
    const nodeTimeout = params.nodeTimeout ? new BN(params.nodeTimeout) : null;
    const ix = await this.program.instruction.queueSetConfigs(
      {
        authority: params.authority ?? null,
        reward: params.reward ?? null,
        nodeTimeout: nodeTimeout,
      },
      {
        accounts: {
          queue: this.pubkey,
          authority: data.authority,
          state: stateKey,
        },
      }
    );
    return ix;
  }

  /**
   * Sets the oracle permission on the queue.
   * @param params.oracle The oracle to set the permission for.
   * @param params.permission The permission to set.
   * @param params.enabled Whether the permission is enabled.
   * @returns A promise that resolves to the transaction instruction   */
  async setOraclePermissionIx(params: {
    oracle: web3.PublicKey;
    permission: SwitchboardPermission;
    enable: boolean;
  }): Promise<web3.TransactionInstruction> {
    const data = await this.loadData();
    return Permission.setIx(this.program, {
      authority: data.authority,
      grantee: params.oracle,
      granter: this.pubkey,
      permission: params.permission,
      enable: params.enable,
    });
  }

  /**
   *  Removes all MR enclaves from the queue.
   *  @returns A promise that resolves to an array of transaction instructions.
   *  @throws if the request fails.
   */
  async rmAllMrEnclaveIxs(): Promise<Array<web3.TransactionInstruction>> {
    const { mrEnclaves, mrEnclavesLen } = await this.loadData();
    const activeEnclaves = mrEnclaves.slice(0, mrEnclavesLen);
    const ixs: Array<web3.TransactionInstruction> = [];
    for (const mrEnclave of activeEnclaves) {
      ixs.push(await this.rmMrEnclaveIx({ mrEnclave }));
    }
    return ixs;
  }

  /**
   *  Fetches most recently added and verified Oracle Key.
   *  @returns A promise that resolves to an oracle public key.
   *  @throws if the request fails.
   */
  async fetchFreshOracle(): Promise<web3.PublicKey> {
    const coder = new BorshAccountsCoder(this.program.idl);
    const now = Math.floor(+new Date() / 1000);
    const oracles = await this.fetchOracleKeys();
    const oracleAccounts = await utils.rpc.getMultipleAccounts(
      this.program.provider.connection,
      oracles
    );
    const oracleUris = oracleAccounts
      .map((x: any) => coder.decode("oracleAccountData", x.account.data))
      .map((x: any) => String.fromCharCode(...x.gatewayUri))
      .map((x: string) => removeTrailingNullBytes(x))
      .filter((x: string) => x.length > 0);

    const tests: Promise<boolean>[] = [];
    for (const i in oracleUris) {
      const gw = new Gateway(this.program, oracleUris[i], oracles[i]);
      tests.push(gw.test());
    }

    const zip: any = [];
    for (let i = 0; i < oracles.length; i++) {
      try {
        const isGood = await withTimeout(tests[i], 2000);
        if (!isGood) {
          continue;
        }
      } catch (e) {
        console.log("Gateway Timeout", e);
      }
      zip.push({
        data: coder.decode(
          "oracleAccountData",
          oracleAccounts[i]!.account!.data
        ),
        key: oracles[i],
      });
    }
    const validOracles = zip
      .filter((x: any) => x.data.enclave.verificationStatus === 4) // value 4 is for verified
      .filter((x: any) => x.data.enclave.validUntil > now + 3600); // valid for 1 hour at least
    if (validOracles.length === 0) {
      throw new Error("NoValidOracles");
    }

    const chosen =
      validOracles[Math.floor(Math.random() * validOracles.length)];
    return chosen.key;
  }

  /**
   * Get the PDA for the queue (SVM chains that are not solana)
   * @returns Queue PDA Pubkey
   */
  queuePDA(): web3.PublicKey {
    return Queue.queuePDA(this.program, this.pubkey);
  }

  /**
   * Get the PDA for the queue (SVM chains that are not solana)
   * @param program Anchor program
   * @param pubkey Queue pubkey
   * @returns Queue PDA Pubkey
   */
  static queuePDA(program: Program, pubkey: web3.PublicKey): web3.PublicKey {
    const [queuePDA] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("Queue"), pubkey.toBuffer()],
      program.programId
    );
    return queuePDA;
  }

  async lutSigner(): Promise<web3.PublicKey> {
    return (
      await web3.PublicKey.findProgramAddress(
        [Buffer.from("LutSigner"), this.pubkey.toBuffer()],
        this.program.programId
      )
    )[0];
  }

  async lutKey(lutSlot: number): Promise<web3.PublicKey> {
    const lutSigner = await this.lutSigner();
    const [_, lutKey] = await web3.AddressLookupTableProgram.createLookupTable({
      authority: lutSigner,
      payer: web3.PublicKey.default,
      recentSlot: lutSlot,
    });
    return lutKey;
  }

  async loadLookupTable(): Promise<web3.AddressLookupTableAccount> {
    const data = await this.loadData();
    const lutKey = await this.lutKey(data.lutSlot);
    const accnt = await this.program.provider.connection.getAddressLookupTable(
      lutKey
    );
    return accnt.value!;
  }
}
