import {
  SOL_NATIVE_MINT,
  SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
  SPL_SYSVAR_INSTRUCTIONS_ID,
  SPL_SYSVAR_SLOT_HASHES_ID,
  SPL_TOKEN_PROGRAM_ID,
} from "./../constants.js";
import { InstructionUtils } from "./../instruction-utils/InstructionUtils.js";
import type { Secp256k1Signature } from "./../instruction-utils/Secp256k1InstructionUtils.js";
import { Secp256k1InstructionUtils } from "./../instruction-utils/Secp256k1InstructionUtils.js";
import type {
  FeedEvalResponse,
  FetchSignaturesConsensusResponse,
} from "./../oracle-interfaces/gateway.js";
import { RecentSlotHashes } from "./../sysvars/recentSlothashes.js";
import * as spl from "./../utils/index.js";
import { Oracle } from "./oracle.js";
import { Queue } from "./queue.js";
import { State } from "./state.js";

import type { Program } from "@coral-xyz/anchor";
import { BN, BorshAccountsCoder, web3 } from "@coral-xyz/anchor";
import type { IOracleJob } from "@switchboard-xyz/common";
import {
  Big,
  CrossbarClient,
  FeedHash,
  NonEmptyArrayUtils,
} from "@switchboard-xyz/common";
import { Buffer } from "buffer";

export interface CurrentResult {
  value: BN;
  stdDev: BN;
  mean: BN;
  range: BN;
  minValue: BN;
  maxValue: BN;
  slot: BN;
  minSlot: BN;
  maxSlot: BN;
}

export interface CompactResult {
  stdDev: number;
  mean: number;
  slot: BN;
}

export interface OracleSubmission {
  oracle: web3.PublicKey;
  slot: BN;
  value: BN;
}

export interface PullFeedAccountData {
  submissions: OracleSubmission[];
  authority: web3.PublicKey;
  queue: web3.PublicKey;
  feedHash: Uint8Array;
  initializedAt: BN;
  permissions: BN;
  maxVariance: BN;
  minResponses: number;
  name: Uint8Array;
  sampleSize: number;
  lastUpdateTimestamp: BN;
  lutSlot: BN;
  result: CurrentResult;
  maxStaleness: number;
  minSampleSize: number;
  historicalResultIdx: number;
  historicalResults: CompactResult[];
}

export type MultiSubmission = {
  values: BN[];
  signature: Buffer; // TODO: Does this need to be made a Uint8Array too?
  recoveryId: number;
};

export class OracleResponse {
  constructor(
    readonly oracle: Oracle,
    readonly value: Big | null,
    readonly error: string
  ) {}

  shortError(): string | undefined {
    if (this.error === "[]") {
      return undefined;
    }
    const parts = this.error.split("\n");
    return parts[0];
  }
}

export type FeedRequest = {
  maxVariance: number;
  minResponses: number;
  jobs: IOracleJob[];
};

function padStringWithNullBytes(
  input: string,
  desiredLength: number = 32
): string {
  const nullByte = "\0";
  while (input.length < desiredLength) {
    input += nullByte;
  }
  return input;
}

export type FeedSubmission = { value: Big; slot: BN; oracle: web3.PublicKey };

export function toFeedValue(
  submissions: FeedSubmission[],
  onlyAfter: BN
): FeedSubmission | null {
  let values = submissions.filter((x) => x.slot.gt(onlyAfter));
  if (values.length === 0) {
    return null;
  }
  values = values.sort((x, y) => (x.value.lt(y.value) ? -1 : 1));
  return values[Math.floor(values.length / 2)];
}

/**
 *  Checks if the pull feed account needs to be initialized.
 *
 *  @param connection The connection to use.
 *  @param programId The program ID.
 *  @param pubkey The public key of the pull feed account.
 *  @returns A promise that resolves to a boolean indicating if the account needs to be initialized.
 */
async function checkNeedsInit(
  connection: web3.Connection,
  programId: web3.PublicKey,
  pubkey: web3.PublicKey
): Promise<boolean> {
  const accountInfo = await connection.getAccountInfo(pubkey);
  if (accountInfo === null) return true;

  const owner = accountInfo.owner;
  if (!owner.equals(programId)) return true;

  return false;
}

/**
 *  Abstraction around the Switchboard-On-Demand Feed account
 *
 *  This account is used to store the feed data and the oracle responses
 *  for a given feed.
 */
export class PullFeed {
  gatewayUrl: string;
  pubkey: web3.PublicKey;
  configs: {
    queue: web3.PublicKey;
    maxVariance: number;
    minResponses: number;
    feedHash: Buffer;
    minSampleSize: number;
  } | null;
  jobs: IOracleJob[] | null;
  lut: web3.AddressLookupTableAccount | null;

  /**
   * Constructs a `PullFeed` instance.
   *
   * @param program - The Anchor program instance.
   * @param pubkey - The public key of the pull feed account.
   */
  constructor(readonly program: Program, pubkey: web3.PublicKey | string) {
    this.gatewayUrl = "";
    this.pubkey = new web3.PublicKey(pubkey);
    this.configs = null;
    this.jobs = null;
  }

  static generate(program: Program): [PullFeed, web3.Keypair] {
    const keypair = web3.Keypair.generate();
    const feed = new PullFeed(program, keypair.publicKey);
    return [feed, keypair];
  }

  static async initTx(
    program: Program,
    params: {
      name: string;
      queue: web3.PublicKey;
      maxVariance: number;
      minResponses: number;
      minSampleSize: number;
      maxStaleness: number;
      permitWriteByAuthority?: boolean;
      payer?: web3.PublicKey;
    } & ({ feedHash: Buffer } | { jobs: IOracleJob[] })
  ): Promise<[PullFeed, web3.VersionedTransaction]> {
    const [pullFeed, keypair] = PullFeed.generate(program);
    const ix = await pullFeed.initIx(params);
    const tx = await InstructionUtils.asV0TxWithComputeIxs({
      connection: program.provider.connection,
      ixs: [ix],
    });
    tx.sign([keypair]);
    return [pullFeed, tx];
  }

  private static getPayer(
    program: Program,
    payer?: web3.PublicKey
  ): web3.PublicKey {
    return payer ?? program.provider.publicKey ?? web3.PublicKey.default;
  }

  private getPayer(payer?: web3.PublicKey): web3.PublicKey {
    return PullFeed.getPayer(this.program, payer);
  }

  /**
   *  Calls to initialize a pull feed account and to update the configuration account need to
   *  compute the feed hash for the account (if one is not specified).
   */
  private static feedHashFromParams(params: {
    queue: web3.PublicKey;
    feedHash?: Buffer;
    jobs?: IOracleJob[];
  }): Buffer {
    const hash = (() => {
      if (params.feedHash) {
        // If the feed hash is provided, use it.
        return params.feedHash;
      } else if (params.jobs?.length) {
        // Else if jobs are provided, compute the feed hash from the queue and jobs.
        return FeedHash.compute(params.queue.toBuffer(), params.jobs);
      }
      throw new Error('Either "feedHash" or "jobs" must be provided.');
    })();
    if (hash.byteLength === 32) return hash;
    throw new Error("Feed hash must be 32 bytes");
  }

  private static async loadDefaultQueue(program: Program, isMainnet: boolean) {
    return await spl.getQueue({
      program: program,
      queueAddress: isMainnet
        ? spl.ON_DEMAND_MAINNET_QUEUE
        : spl.ON_DEMAND_DEVNET_QUEUE,
    });
  }

  /**
   * Initializes a pull feed account.
   *
   * @param {Program} program - The Anchor program instance.
   * @param {PublicKey} queue - The queue account public key.
   * @param {Array<IOracleJob>} jobs - The oracle jobs to execute.
   * @param {number} maxVariance - The maximum variance allowed for the feed.
   * @param {number} minResponses - The minimum number of job responses required.
   * @param {number} minSampleSize - The minimum number of samples required for setting feed value.
   * @param {number} maxStaleness - The maximum number of slots that can pass before a feed value is considered stale.
   * @returns {Promise<web3.TransactionInstruction>} A promise that resolves to the transaction instruction.
   */
  async initIx(
    params: {
      name: string;
      queue: web3.PublicKey;
      maxVariance: number;
      minResponses: number;
      payer?: web3.PublicKey;
      minSampleSize: number;
      maxStaleness: number;
      permitWriteByAuthority?: boolean;
    } & ({ feedHash: Buffer } | { jobs: IOracleJob[] })
  ): Promise<web3.TransactionInstruction> {
    const feedHash = PullFeed.feedHashFromParams({
      queue: params.queue,
      feedHash: "feedHash" in params ? params.feedHash : undefined,
      jobs: "jobs" in params ? params.jobs : undefined,
    });
    const payerPublicKey = this.getPayer(params.payer);
    const maxVariance = Math.floor(params.maxVariance * 1e9);
    const lutSigner = (
      await web3.PublicKey.findProgramAddress(
        [Buffer.from("LutSigner"), this.pubkey.toBuffer()],
        this.program.programId
      )
    )[0];
    const recentSlot = await this.program.provider.connection.getSlot(
      "finalized"
    );
    const [_, lut] = web3.AddressLookupTableProgram.createLookupTable({
      authority: lutSigner,
      payer: payerPublicKey,
      recentSlot,
    });
    const ix = this.program.instruction.pullFeedInit(
      {
        feedHash: feedHash,
        maxVariance: new BN(maxVariance),
        minResponses: params.minResponses,
        name: Buffer.from(padStringWithNullBytes(params.name)),
        recentSlot: new BN(recentSlot),
        ipfsHash: new Uint8Array(32), // Deprecated.
        minSampleSize: params.minSampleSize,
        maxStaleness: params.maxStaleness,
        permitWriteByAuthority: params.permitWriteByAuthority ?? null,
      },
      {
        accounts: {
          pullFeed: this.pubkey,
          queue: params.queue,
          authority: payerPublicKey,
          payer: payerPublicKey,
          systemProgram: web3.SystemProgram.programId,
          programState: State.keyFromSeed(this.program),
          rewardEscrow: spl.getAssociatedTokenAddressSync(
            SOL_NATIVE_MINT,
            this.pubkey
          ),
          tokenProgram: SPL_TOKEN_PROGRAM_ID,
          associatedTokenProgram: SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
          wrappedSolMint: SOL_NATIVE_MINT,
          lutSigner,
          lut,
          addressLookupTableProgram: web3.AddressLookupTableProgram.programId,
        },
      }
    );
    return ix;
  }

  async closeIx(params: {
    payer?: web3.PublicKey;
  }): Promise<web3.TransactionInstruction> {
    const payerPublicKey = this.getPayer(params.payer);
    const lutSigner = (
      await web3.PublicKey.findProgramAddress(
        [Buffer.from("LutSigner"), this.pubkey.toBuffer()],
        this.program.programId
      )
    )[0];
    const data = await this.loadData();
    const [_, lut] = web3.AddressLookupTableProgram.createLookupTable({
      authority: lutSigner,
      payer: payerPublicKey,
      recentSlot: BigInt(data.lutSlot.toString()),
    });
    const ix = this.program.instruction.pullFeedClose(
      {},
      {
        accounts: {
          pullFeed: this.pubkey,
          authority: data.authority,
          payer: payerPublicKey,
          rewardEscrow: spl.getAssociatedTokenAddressSync(
            SOL_NATIVE_MINT,
            this.pubkey
          ),
          lutSigner,
          lut,
          state: State.keyFromSeed(this.program),
          tokenProgram: SPL_TOKEN_PROGRAM_ID,
          associatedTokenProgram: SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
          systemProgram: web3.SystemProgram.programId,
          addressLookupTableProgram: web3.AddressLookupTableProgram.programId,
        },
      }
    );
    return ix;
  }

  /**
   * Set configurations for the feed.
   *
   * @param params
   * @param params.feedHash - The hash of the feed as a `Uint8Array` or hexadecimal `string`. Only results signed with this hash will be accepted.
   * @param params.authority - The authority of the feed.
   * @param params.maxVariance - The maximum variance allowed for the feed.
   * @param params.minResponses - The minimum number of responses required.
   * @param params.minSampleSize - The minimum number of samples required for setting feed value.
   * @param params.maxStaleness - The maximum number of slots that can pass before a feed value is considered stale.
   * @returns A promise that resolves to the transaction instruction to set feed configs.
   */
  async setConfigsIx(params: {
    name?: string;
    authority?: web3.PublicKey;
    maxVariance?: number;
    minResponses?: number;
    feedHash?: Buffer;
    jobs?: IOracleJob[];
    minSampleSize?: number;
    maxStaleness?: number;
    permitWriteByAuthority?: boolean;
  }): Promise<web3.TransactionInstruction> {
    const data = await this.loadData();
    const name =
      params.name !== undefined
        ? Buffer.from(padStringWithNullBytes(params.name))
        : null;
    const feedHash =
      params.feedHash || params.jobs
        ? PullFeed.feedHashFromParams({
            queue: data.queue,
            feedHash: params.feedHash,
            jobs: params.jobs,
          })
        : null;

    const ix = this.program.instruction.pullFeedSetConfigs(
      {
        name: name,
        feedHash: feedHash,
        authority: params.authority ?? null,
        maxVariance:
          params.maxVariance !== undefined
            ? new BN(Math.floor(params.maxVariance * 1e9))
            : null,
        minResponses: params.minResponses ?? null,
        minSampleSize: params.minSampleSize ?? null,
        maxStaleness: params.maxStaleness ?? null,
        permitWriteByAuthority: params.permitWriteByAuthority ?? null,
        ipfsHash: null, // Deprecated.
      },
      {
        accounts: {
          pullFeed: this.pubkey,
          authority: data.authority,
        },
      }
    );
    return ix;
  }

  /**
   * Fetch updates for the feed.
   *
   * @param {object} params_ - The parameters object.
   * @param {string} [params_.gateway] - Optionally specify the gateway to use. If not specified, the gateway is automatically fetched.
   * @param {number} [params_.numSignatures] - Number of signatures to fetch.
   * @param {FeedRequest} [params_.feedConfigs] - Optionally specify the feed configs. If not specified, the feed configs are automatically fetched.
   * @param {IOracleJob[]} [params_.jobs] - An array of `IOracleJob` representing the jobs to be executed.
   * @param {CrossbarClient} [params_.crossbarClient] - Optionally specify the CrossbarClient to use.
   * @param {Array<[BN, string]>} [recentSlothashes] - An optional array of recent slothashes as `[BN, string]` tuples.
   * @param {FeedEvalResponse[]} [priceSignatures] - An optional array of `FeedEvalResponse` representing the price signatures.
   * @param {boolean} [debug=false] - A boolean flag to enable or disable debug mode. Defaults to `false`.
   * @returns {Promise<[TransactionInstruction | undefined, OracleResponse[], number, any[]]>} A promise that resolves to a tuple containing:
   * - The transaction instruction to fetch updates, or `undefined` if not applicable.
   * - An array of `OracleResponse` objects.
   * - A number representing the successful responses.
   * - An array containing usable lookup tables.
   */
  async fetchUpdateIx(
    params_?: {
      // Optionally specify the gateway to use. Else, the gateway is automatically fetched.
      gateway?: string;
      // Number of signatures to fetch.
      numSignatures?: number;
      jobs?: IOracleJob[];
      crossbarClient?: CrossbarClient;
      retries?: number;
      chain?: string;
      network?: "mainnet" | "mainnet-beta" | "testnet" | "devnet";
      solanaRpcUrl?: string;
    },
    recentSlothashes?: Array<[BN, string]>,
    priceSignatures?: FeedEvalResponse[],
    debug: boolean = false,
    payer?: web3.PublicKey
  ): Promise<
    [
      web3.TransactionInstruction | undefined,
      OracleResponse[],
      number,
      web3.AddressLookupTableAccount[],
      string[]
    ]
  > {
    const payerPublicKey = this.getPayer(payer);
    if (this.configs === null) {
      this.configs = await this.loadConfigs();
    }

    params_ = params_ ?? {};
    params_.retries = params_.retries ?? 3;
    const feedConfigs = this.configs;
    const numSignatures =
      params_?.numSignatures ??
      feedConfigs.minSampleSize + Math.ceil(feedConfigs.minSampleSize / 3);
    const isSolana =
      params_?.chain === undefined || params_?.chain === "solana";
    const isMainnet =
      params_?.network === "mainnet" || params_?.network === "mainnet-beta";

    let queueAccount = new Queue(this.program, feedConfigs.queue);

    if (!isSolana) {
      queueAccount = await PullFeed.loadDefaultQueue(this.program, isMainnet);
    }

    if (this.gatewayUrl === "") {
      this.gatewayUrl =
        params_?.gateway ??
        (await queueAccount.fetchAllGateways())[0].gatewayUrl;
    }
    let jobs = params_?.jobs ?? this.jobs;
    if (!jobs?.length) {
      const data = await this.loadData();
      jobs = await (params_?.crossbarClient ?? CrossbarClient.default())
        .fetch(Buffer.from(data.feedHash).toString("hex"))
        .then((resp) => {
          return resp.jobs;
        });
      this.jobs = jobs;
    }
    const params = {
      feed: this.pubkey,
      gateway: this.gatewayUrl,
      ...feedConfigs,
      ...params_,
      numSignatures,
      jobs: jobs,
    };
    let err = null;
    for (let i = 0; i < params.retries; i++) {
      try {
        const ix = await PullFeed.fetchUpdateIx(
          this.program,
          params,
          recentSlothashes,
          priceSignatures,
          debug,
          payerPublicKey
        );
        return ix;
      } catch (err_: any) {
        err = err_;
      }
    }
    throw err;
  }

  /**
   * Loads the feed configurations for this {@linkcode PullFeed} account from on chain.
   * @returns A promise that resolves to the feed configurations.
   * @throws if the feed account does not exist.
   */
  async loadConfigs(): Promise<{
    queue: web3.PublicKey;
    maxVariance: number;
    minResponses: number;
    feedHash: Buffer;
    minSampleSize: number;
  }> {
    const data = await this.loadData();
    const maxVariance = data.maxVariance.toNumber() / 1e9;
    return {
      queue: data.queue,
      maxVariance: maxVariance,
      minResponses: data.minResponses,
      feedHash: Buffer.from(data.feedHash),
      minSampleSize: data.minSampleSize,
    };
  }

  /**
   * Fetch updates for the feed.
   *
   * @param params_ - The parameters object.
   * @param params_.gateway - Optionally specify the gateway to use. If not specified, the gateway is automatically fetched.
   * @param params._chain - Optionally specify the chain to use. If not specified, Solana is used.
   * @param params_.numSignatures - Number of signatures to fetch.
   * @param params_.feedConfigs - Optionally specify the feed configs. If not specified, the feed configs are automatically fetched.
   * @param params_.jobs - An array of `IOracleJob` representing the jobs to be executed.
   * @param params_.crossbarClient - Optionally specify the CrossbarClient to use.
   * @param recentSlothashes - An optional array of recent slothashes as `[BN, string]` tuples.
   * @param priceSignatures - An optional array of `FeedEvalResponse` representing the price signatures.
   * @param debug - A boolean flag to enable or disable debug mode. Defaults to `false`.
   * @param payer - Optionally specify the payer public key.
   * @returns A promise that resolves to a tuple containing:
   * - The transaction instruction to fetch updates, or `undefined` if not applicable.
   * - An array of `OracleResponse` objects.
   * - A number representing the successful responses.
   * - An array containing usable lookup tables.
   */
  static async fetchUpdateIx(
    program: Program,
    params_: {
      gateway?: string;
      chain?: string;
      network?: "mainnet" | "mainnet-beta" | "testnet" | "devnet";
      solanaRpcUrl?: string;
      queue: web3.PublicKey;
      feed: web3.PublicKey;
      numSignatures: number;
      maxVariance: number;
      minResponses: number;
      jobs: IOracleJob[];
      crossbarClient?: CrossbarClient;
    },
    recentSlothashes?: Array<[BN, string]>,
    priceSignatures?: FeedEvalResponse[],
    debug: boolean = false,
    payer?: web3.PublicKey
  ): Promise<
    [
      web3.TransactionInstruction | undefined,
      OracleResponse[],
      number,
      web3.AddressLookupTableAccount[],
      string[]
    ]
  > {
    let slotHashes = recentSlothashes;
    if (slotHashes === undefined) {
      slotHashes = await RecentSlotHashes.fetchLatestNSlothashes(
        program.provider.connection,
        30
      );
    }
    const feed = new PullFeed(program, params_.feed);
    const params = params_;
    const isSolana = params.chain === undefined || params.chain === "solana";
    const isMainnet =
      params.network === "mainnet" || params.network === "mainnet-beta";
    let queue = params.queue;

    let failures_: string[] = [];
    if (priceSignatures === undefined || priceSignatures === null) {
      let solanaProgram = program;

      // get the queue
      if (!isSolana) {
        // TODO: cache this
        const defaultQueue = await PullFeed.loadDefaultQueue(
          program,
          isMainnet
        );

        queue = defaultQueue.pubkey;
        solanaProgram = defaultQueue.program;
      }

      const { responses, failures } = await Queue.fetchSignatures(
        solanaProgram,
        {
          ...params,
          queue: queue,
          recentHash: slotHashes[0][1],
        }
      );
      priceSignatures = responses;
      failures_ = failures;
    }

    let numSuccesses = 0;
    if (!priceSignatures) {
      return [undefined, [], 0, [], []];
    }
    const oracleResponses = priceSignatures.map((x) => {
      const oldDP = Big.DP;
      Big.DP = 40;
      const value = x.success_value ? new Big(x.success_value).div(1e18) : null;
      if (value !== null) {
        numSuccesses += 1;
      }
      Big.DP = oldDP;
      let oracle = new web3.PublicKey(Buffer.from(x.oracle_pubkey, "hex"));
      if (!isSolana) {
        [oracle] = web3.PublicKey.findProgramAddressSync(
          [Buffer.from("Oracle"), params.queue.toBuffer(), oracle.toBuffer()],
          program.programId
        );
      }
      return new OracleResponse(
        new Oracle(program, oracle),
        value,
        x.failure_error
      );
    });

    const offsets: number[] = new Array(priceSignatures.length).fill(0);
    for (let i = 0; i < priceSignatures.length; i++) {
      if (priceSignatures[i].failure_error.length > 0) {
        let validResp = false;
        for (const recentSignature of priceSignatures[i]
          .recent_successes_if_failed) {
          for (let offset = 0; offset < slotHashes.length; offset++) {
            const slotHash = slotHashes[offset];
            if (slotHash[1] === recentSignature.recent_hash) {
              priceSignatures[i] = recentSignature;
              offsets[i] = offset;
              validResp = true;
              break;
            }
          }
          if (validResp) {
            break;
          }
        }
      }
    }
    if (debug) {
      console.log("priceSignatures", priceSignatures);
    }

    let submitSignaturesIx: web3.TransactionInstruction | undefined = undefined;
    if (numSuccesses > 0) {
      submitSignaturesIx = feed.getSolanaSubmitSignaturesIx({
        resps: priceSignatures,
        offsets: offsets,
        slot: slotHashes[0][0],
        payer,
        chain: params.chain,
      });
    }
    if (!numSuccesses) {
      throw new Error(
        `PullFeed.fetchUpdateIx Failure: ${oracleResponses.map((x) => x.error)}`
      );
    }

    let luts = [];
    try {
      const lutOwners = [...oracleResponses.map((x) => x.oracle), feed];
      luts = await spl.loadLookupTables(lutOwners);
    } catch {}
    return [submitSignaturesIx, oracleResponses, numSuccesses, luts, failures_];
  }

  /**
   * Fetches updates for multiple feeds at once into SEPARATE intructions (one for each)
   *
   * @param program - The Anchor program instance.
   * @param params_ - The parameters object.
   * @param params_.gateway - The gateway URL to use. If not provided, the gateway is automatically fetched.
   * @param params_.feeds - An array of feed account public keys.
   * @param params_.numSignatures - The number of signatures to fetch.
   * @param params_.crossbarClient - Optionally specify the CrossbarClient to use.
   * @param recentSlothashes - An optional array of recent slothashes as `[BN, string]` tuples.
   * @param debug - A boolean flag to enable or disable debug mode. Defaults to `false`.
   * @param payer - Optionally specify the payer public key.
   * @returns A promise that resolves to a tuple containing:
   * - The transaction instruction for fetching updates.
   * - An array of `AddressLookupTableAccount` to use.
   * - The raw response data.
   */
  static async fetchUpdateManyIxs(
    program: Program,
    params_: {
      feeds: web3.PublicKey[];
      numSignatures: number;
      gateway?: string;
      recentSlothashes?: Array<[BN, string]>;
      crossbarClient?: CrossbarClient;
      payer?: web3.PublicKey;
    },
    debug: boolean = false,
    payer?: web3.PublicKey
  ): Promise<{
    successes: {
      submitSignaturesIx: web3.TransactionInstruction;
      oracleResponses: {
        value: Big;
        error: string;
        oracle: Oracle;
      };
      numSuccesses: number;
      luts: web3.AddressLookupTableAccount[];
      failures: string[];
    }[];
    failures: {
      feed: web3.PublicKey;
      error: string;
    }[];
  }> {
    const slotHashes =
      params_.recentSlothashes ??
      (await RecentSlotHashes.fetchLatestNSlothashes(
        program.provider.connection,
        30
      ));
    const feeds = params_.feeds.map((feed) => new PullFeed(program, feed));
    const params = params_;
    const feedConfigs: {
      maxVariance: number;
      minResponses: number;
      jobs: any;
    }[] = [];
    let queue: web3.PublicKey | undefined = undefined;

    // Map from feed hash to feed - this will help in mapping the responses to the feeds
    const feedToFeedHash = new Map<string, string>();

    // Map from feed hash to responses
    const feedHashToResponses = new Map<string, FeedEvalResponse[]>();

    // Iterate over all feeds to fetch the feed configs
    for (const feed of feeds) {
      // Load the feed from Solana
      const data = await feed.loadData();
      if (queue !== undefined && !queue.equals(data.queue)) {
        throw new Error(
          "fetchUpdateManyIx: All feeds must have the same queue"
        );
      }
      queue = data.queue;
      const maxVariance = data.maxVariance.toNumber() / 1e9;
      const minResponses = data.minResponses;
      const feedHash = Buffer.from(data.feedHash).toString("hex");

      // Store the feed in a map for later use
      feedToFeedHash.set(feed.pubkey.toString(), feedHash);

      // Add an entry for the feed in the response map
      feedHashToResponses.set(feedHash, []);

      // Pull the job definitions
      const jobs = await (params_.crossbarClient ?? CrossbarClient.default())
        .fetch(feedHash)
        .then((resp) => {
          return resp.jobs;
        });

      // Collect the feed config
      feedConfigs.push({
        maxVariance,
        minResponses,
        jobs,
      });
    }

    // Fetch the responses from the oracle(s)
    const response = await Queue.fetchSignaturesBatch(program, {
      ...params,
      recentHash: slotHashes[0][1],
      feedConfigs,
      queue: queue!,
    });

    const oracles: web3.PublicKey[] = [];

    // Assemble the responses
    for (const oracleResponse of response.oracle_responses) {
      // Get the oracle public key
      const oraclePubkey = new web3.PublicKey(
        Buffer.from(oracleResponse.feed_responses[0].oracle_pubkey, "hex")
      );

      // Add it to the list of oracles
      oracles.push(oraclePubkey);

      // Map the responses to the feed
      for (const feedResponse of oracleResponse.feed_responses) {
        const feedHash = feedResponse.feed_hash;
        feedHashToResponses.get(feedHash)?.push(feedResponse);
      }
    }

    // loop over the feeds and create the instructions
    const successes = [];
    const failures = [];

    for (const feed of feeds) {
      const feedHash = feedToFeedHash.get(feed.pubkey.toString());

      // Get registered responses for this feed
      const responses = feedHashToResponses.get(feedHash) ?? [];

      // If there are no responses for this feed, skip
      if (responses.length === 0) {
        failures.push({
          feed: feed.pubkey,
          error: `No responses found for feed hash: ${feedHash}. Skipping.`,
        });
        continue;
      }

      const oracleResponses = responses.map((x) => {
        const oldDP = Big.DP;
        Big.DP = 40;
        const value = x.success_value
          ? new Big(x.success_value).div(1e18)
          : null;
        Big.DP = oldDP;
        return {
          value,
          error: x.failure_error,
          oracle: new Oracle(
            program,
            new web3.PublicKey(Buffer.from(x.oracle_pubkey, "hex"))
          ),
        };
      });

      // offsets currently deprecated
      const offsets: number[] = Array(responses.length).fill(0);

      if (debug) {
        console.log("priceSignatures", responses);
      }

      let submitSignaturesIx: web3.TransactionInstruction | undefined =
        undefined;
      let numSuccesses = 0;
      if (responses.length > 0) {
        const validResponses = responses.filter(
          (x) => (x.signature ?? "").length > 0
        );
        numSuccesses = validResponses.length;
        if (numSuccesses > 0) {
          submitSignaturesIx = feed.getSolanaSubmitSignaturesIx({
            resps: validResponses,
            offsets: offsets,
            slot: slotHashes[0][0],
            payer: PullFeed.getPayer(program, params.payer),
          });
        }
      }

      // Bounce if there are no successes
      if (!numSuccesses) {
        const failure = {
          feed: feed.pubkey,
          error: `PullFeed.fetchUpdateIx Failure: ${oracleResponses.map(
            (x) => x.error
          )}`,
        };
        failures.push(failure);
        continue;
      }

      // Get lookup tables for the oracles
      const lutOwners = [...oracleResponses.map((x) => x.oracle), feed];
      const luts = await spl.loadLookupTables(lutOwners);

      // Add the result to the successes array
      successes.push({
        feed: feed.pubkey,
        submitSignaturesIx,
        oracleResponses,
        numSuccesses,
        luts,
        failures: responses.map((x) => x.failure_error),
      });
    }

    return {
      successes,
      failures,
    };
  }

  /**
   * Prefetch all lookup tables needed for the feed and queue.
   * @returns A promise that resolves to an array of lookup tables.
   * @throws if the lookup tables cannot be loaded.
   */
  async preHeatLuts(): Promise<web3.AddressLookupTableAccount[]> {
    const data = await this.loadData();
    const queue = new Queue(this.program, data.queue);
    const oracleKeys = await queue.fetchOracleKeys();
    const oracles = oracleKeys.map((k) => new Oracle(this.program, k));
    const lutOwners = [...oracles, queue, this];
    const luts = await spl.loadLookupTables(lutOwners);
    return luts;
  }

  /**
   * Fetches updates for multiple feeds at once into a SINGLE tightly packed instruction.
   * Returns instructions that must be executed in order, with the secp256k1 verification
   * instruction placed at the front of the transaction.
   *
   * @param program - The Anchor program instance.
   * @param params_ - The parameters object.
   * @param params_.feeds - An array of PullFeed account public keys.
   * @param params_.gateway - The gateway URL to use. If not provided, the gateway is automatically fetched.
   * @param params_.recentSlothashes - The recent slothashes to use. If not provided, the latest 30 slothashes are fetched.
   * @param params_.numSignatures - The number of signatures to fetch.
   * @param params_.crossbarClient - Optionally specify the CrossbarClient to use.
   * @param params_.payer - The payer of the transaction. If not provided, the payer is automatically fetched.
   * @param debug - A boolean flag to enable or disable debug mode. Defaults to `false`.
   * @returns A promise that resolves to a tuple containing:
   * - An array of transaction instructions that must be executed in order:
   *   [0] = secp256k1 program verification instruction
   *   [1] = feed update instruction
   * - An array of `AddressLookupTableAccount` to use.
   * - The raw response data.
   */
  static async fetchUpdateManyIx(
    program: Program,
    params: {
      feeds: web3.PublicKey[];
      gateway?: string;
      recentSlothashes?: Array<[BN, string]>;
      numSignatures: number;
      crossbarClient?: CrossbarClient;
      payer?: web3.PublicKey;
    },
    debug: boolean = false
  ): Promise<
    [
      web3.TransactionInstruction[],
      web3.AddressLookupTableAccount[],
      FetchSignaturesConsensusResponse
    ]
  > {
    const isSolana = true;

    const feeds = NonEmptyArrayUtils.validate(params.feeds);
    const crossbarClient = params.crossbarClient ?? CrossbarClient.default();

    // Validate that (1) all of the feeds specified exist and (2) all of the feeds are on the same
    // queue. Assuming that these conditions are met, we can map the feeds' data to their configs to
    // request signatures from a gateway.
    const feedDatas = await PullFeed.loadMany(program, feeds);
    const queue: web3.PublicKey = feedDatas[0]?.queue ?? web3.PublicKey.default;
    const feedConfigs: FeedRequest[] = [];
    for (let idx = 0; idx < feedDatas.length; idx++) {
      const data = feedDatas[idx];
      if (!data) {
        const pubkey = feeds[idx];
        throw new Error(`No feed found at ${pubkey.toBase58()}}`);
      } else if (!queue.equals(data.queue)) {
        throw new Error("All feeds must be on the same queue");
      }
      feedConfigs.push({
        maxVariance: data.maxVariance.toNumber() / 1e9,
        minResponses: data.minResponses,
        jobs: await crossbarClient
          .fetch(Buffer.from(data.feedHash).toString("hex"))
          .then((resp) => resp.jobs),
      });
    }

    const connection = program.provider.connection;
    const slotHashes =
      params.recentSlothashes ??
      (await RecentSlotHashes.fetchLatestNSlothashes(connection, 30));
    const response = await Queue.fetchSignaturesConsensus(
      /* program= */ program,
      /* params= */ {
        queue: feedDatas[0]!.queue,
        gateway: params.gateway,
        recentHash: slotHashes[0][1],
        feedConfigs,
        numSignatures: params.numSignatures,
      }
    );

    const secpSignatures: Secp256k1Signature[] =
      response.oracle_responses.map<Secp256k1Signature>((oracleResponse) => {
        return {
          ethAddress: Buffer.from(oracleResponse.eth_address, "hex"),
          signature: Buffer.from(oracleResponse.signature, "base64"),
          message: Buffer.from(oracleResponse.checksum, "base64"),
          recoveryId: oracleResponse.recovery_id,
        };
      });
    const secpInstruction = Secp256k1InstructionUtils.buildSecp256k1Instruction(
      secpSignatures,
      0
    );

    // Prepare the instruction data for the `pullFeedSubmitResponseManySecp` instruction.
    const instructionData = {
      slot: new BN(slotHashes[0][0]),
      values: response.median_responses.map(({ value }) => new BN(value)),
    };

    // Prepare the accounts for the `pullFeedSubmitResponseManySecp` instruction.
    const accounts = {
      queue: queue!,
      programState: State.keyFromSeed(program),
      recentSlothashes: SPL_SYSVAR_SLOT_HASHES_ID,
      payer: PullFeed.getPayer(program, params.payer),
      systemProgram: web3.SystemProgram.programId,
      rewardVault: spl.getAssociatedTokenAddressSync(
        SOL_NATIVE_MINT,
        queue,
        !isSolana // TODO: Review this.
      ),
      tokenProgram: SPL_TOKEN_PROGRAM_ID,
      tokenMint: SOL_NATIVE_MINT,
      ixSysvar: SPL_SYSVAR_INSTRUCTIONS_ID,
    };

    // Prepare the remaining accounts for the `pullFeedSubmitResponseManySecp` instruction.
    const feedPubkeys = feeds;
    const oraclePubkeys = response.oracle_responses.map((response) => {
      return new web3.PublicKey(Buffer.from(response.oracle_pubkey, "hex"));
    });
    const oracleFeedStatsPubkeys = oraclePubkeys.map(
      (oracle) =>
        web3.PublicKey.findProgramAddressSync(
          [Buffer.from("OracleStats"), oracle.toBuffer()],
          program.programId
        )[0]
    );
    const remainingAccounts: web3.AccountMeta[] = [
      ...feedPubkeys.map((feedPubkey) => ({
        pubkey: feedPubkey,
        isSigner: false,
        isWritable: true,
      })),
      ...oraclePubkeys.map((oraclePubkey) => ({
        pubkey: oraclePubkey,
        isSigner: false,
        isWritable: false,
      })),
      ...oracleFeedStatsPubkeys.map((oracleFeedStatsPubkey) => ({
        pubkey: oracleFeedStatsPubkey,
        isSigner: false,
        isWritable: true,
      })),
    ];

    const submitResponseIx =
      program.instruction.pullFeedSubmitResponseConsensus(instructionData, {
        accounts,
        remainingAccounts,
      });

    // Load the lookup tables for the feeds and oracles.
    const loadLookupTables = spl.createLoadLookupTables();
    const luts = await loadLookupTables([
      ...feedPubkeys.map((pubkey) => new PullFeed(program, pubkey)),
      ...oraclePubkeys.map((pubkey) => new Oracle(program, pubkey)),
    ]);

    return [[secpInstruction, submitResponseIx], luts, response];
  }

  /**
   *  Compiles a transaction instruction to submit oracle signatures for a given feed.
   *
   *  @param resps The oracle responses. This may be obtained from the `Gateway` class.
   *  @param slot The slot at which the oracles signed the feed with the current slothash.
   *  @returns A promise that resolves to the transaction instruction.
   */
  getSolanaSubmitSignaturesIx(params: {
    resps: FeedEvalResponse[];
    offsets: number[];
    slot: BN;
    payer?: web3.PublicKey;
    chain?: string;
  }): web3.TransactionInstruction {
    const program = this.program;
    const payerPublicKey = PullFeed.getPayer(program, params.payer);
    const resps = params.resps.filter((x) => (x.signature ?? "").length > 0);
    const isSolana = params.chain === "solana" || params.chain === undefined;

    let queue = new web3.PublicKey(
      Buffer.from(resps[0].queue_pubkey.toString(), "hex")
    );
    const sourceQueueKey = new web3.PublicKey(
      Buffer.from(resps[0].queue_pubkey.toString(), "hex")
    );
    let queueBump = 0;

    if (!isSolana) {
      [queue, queueBump] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("Queue"), queue.toBuffer()],
        program.programId
      );
    }

    const oracles = resps.map((x) => {
      const sourceOracleKey = new web3.PublicKey(
        Buffer.from(x.oracle_pubkey.toString(), "hex")
      );
      if (isSolana) {
        return sourceOracleKey;
      } else {
        const [oraclePDA] = web3.PublicKey.findProgramAddressSync(
          [Buffer.from("Oracle"), queue.toBuffer(), sourceOracleKey.toBuffer()],
          program.programId
        );
        return oraclePDA;
      }
    });

    const oracleFeedStats = oracles.map(
      (oracle) =>
        web3.PublicKey.findProgramAddressSync(
          [Buffer.from("OracleStats"), oracle.toBuffer()],
          program.programId
        )[0]
    );

    const submissions = resps.map((resp, idx) => ({
      value: new BN(resp.success_value.toString()),
      signature: resp.signature,
      recoveryId: resp.recovery_id,

      // offsets aren't used in the non-solana endpoint
      slotOffset: isSolana ? params.offsets[idx] : undefined,
    }));

    const instructionData = {
      slot: new BN(params.slot),
      submissions: submissions.map((x: any) => {
        x.signature = Buffer.from(x.signature, "base64");
        return x;
      }),
      sourceQueueKey: isSolana ? undefined : sourceQueueKey,
      queueBump: isSolana ? undefined : queueBump,
    };

    const accounts = {
      feed: this.pubkey,
      queue: queue,
      programState: State.keyFromSeed(program),
      recentSlothashes: SPL_SYSVAR_SLOT_HASHES_ID,
      payer: payerPublicKey,
      systemProgram: web3.SystemProgram.programId,
      rewardVault: spl.getAssociatedTokenAddressSync(
        SOL_NATIVE_MINT,
        queue,
        !isSolana
      ),
      tokenProgram: SPL_TOKEN_PROGRAM_ID,
      tokenMint: SOL_NATIVE_MINT,
    };

    const remainingAccounts: web3.AccountMeta[] = [
      ...oracles.map((k) => ({
        pubkey: k,
        isSigner: false,
        isWritable: false,
      })),
      ...oracleFeedStats.map((k) => ({
        pubkey: k,
        isSigner: false,
        isWritable: true,
      })),
    ];

    if (isSolana) {
      return program.instruction.pullFeedSubmitResponse(instructionData, {
        accounts,
        remainingAccounts,
      });
    } else {
      return program.instruction.pullFeedSubmitResponseSvm(instructionData, {
        accounts,
        remainingAccounts,
      });
    }
  }

  /**
   *  Checks if the pull feed account has been initialized.
   *
   *  @returns A promise that resolves to a boolean indicating if the account has been initialized.
   */
  async isInitializedAsync(): Promise<boolean> {
    return !(await checkNeedsInit(
      this.program.provider.connection,
      this.program.programId,
      this.pubkey
    ));
  }

  /**
   *  Loads the feed data for this {@linkcode PullFeed} account from on chain.
   *
   *  @returns A promise that resolves to the feed data.
   *  @throws if the feed account does not exist.
   */
  async loadData(): Promise<PullFeedAccountData> {
    return await this.program.account["pullFeedAccountData"].fetch(this.pubkey);
  }

  /**
   *  Loads the feed data for multiple feeds at once.
   *
   *  @param program The program instance.
   *  @param pubkeys The public keys of the feeds to load.
   *  @returns A promise that resolves to an array of feed data (or null if the feed account does not exist)
   */
  static async loadMany(
    program: Program,
    pubkeys: web3.PublicKey[]
  ): Promise<(PullFeedAccountData | null)[]> {
    return await program.account["pullFeedAccountData"].fetchMultiple(pubkeys);
  }

  /**
   *  Loads the feed data for this {@linkcode PullFeed} account from on chain.
   *
   *  @returns A promise that resolves to the values currently stored in the feed.
   *  @throws if the feed account does not exist.
   */
  async loadValues(): Promise<
    Array<{ value: Big; slot: BN; oracle: web3.PublicKey }>
  > {
    const data = await this.loadData();
    return data.submissions
      .filter((x: any) => !x.oracle.equals(web3.PublicKey.default))
      .map((x: any) => {
        Big.DP = 40;
        return {
          value: new Big(x.value.toString()).div(1e18),
          slot: new BN(x.slot.toString()),
          oracle: new web3.PublicKey(x.oracle),
        };
      });
  }

  /**
   *  Loads the feed data for this {@linkcode PullFeed} account from on chain.
   *
   *  @param onlyAfter Call will ignore data signed before this slot.
   *  @returns A promise that resolves to the observed value as it would be
   *           seen on-chain.
   */
  async loadObservedValue(onlyAfter: BN): Promise<{
    value: Big;
    slot: BN;
    oracle: web3.PublicKey;
  } | null> {
    const values = await this.loadValues();
    return toFeedValue(values, onlyAfter);
  }

  /**
   * Watches for any on-chain updates to the feed data.
   *
   * @param callback The callback to call when the feed data is updated.
   * @returns A promise that resolves to a subscription ID.
   */
  async subscribeToValueChanges(callback: any): Promise<number> {
    const coder = new BorshAccountsCoder(this.program.idl);
    const subscriptionId = this.program.provider.connection.onAccountChange(
      this.pubkey,
      async (accountInfo, context) => {
        const feed = coder.decode("pullFeedAccountData", accountInfo.data);
        await callback(
          feed.submissions
            .filter((x: any) => !x.oracle.equals(web3.PublicKey.default))
            .map((x: any) => {
              Big.DP = 40;
              return {
                value: new Big(x.value.toString()).div(1e18),
                slot: new BN(x.slot.toString()),
                oracle: new web3.PublicKey(x.oracle),
              };
            })
        );
      },
      "processed"
    );
    return subscriptionId;
  }

  /**
   * Watches for any on-chain updates to any data feed.
   *
   * @param program The Anchor program instance.
   * @param callback The callback to call when the feed data is updated.
   * @returns A promise that resolves to a subscription ID.
   */
  static async subscribeToAllUpdates(
    program: Program,
    callback: (
      event: [number, { pubkey: web3.PublicKey; submissions: FeedSubmission[] }]
    ) => Promise<void>
  ): Promise<number> {
    const coder = new BorshAccountsCoder(program.idl);
    const subscriptionId = program.provider.connection.onProgramAccountChange(
      program.programId,
      async (keyedAccountInfo, ctx) => {
        const { accountId, accountInfo } = keyedAccountInfo;
        try {
          const feed = coder.decode("pullFeedAccountData", accountInfo.data);
          await callback([
            ctx.slot,
            {
              pubkey: accountId,
              submissions: feed.submissions
                .filter((x) => !x.oracle.equals(web3.PublicKey.default))
                .map((x) => {
                  Big.DP = 40;
                  return {
                    value: new Big(x.value.toString()).div(1e18),
                    slot: new BN(x.slot.toString()),
                    oracle: new web3.PublicKey(x.oracle),
                  };
                }),
            },
          ]);
        } catch (e) {
          console.log(`ParseFailure: ${e}`);
        }
      },
      "processed",
      [
        {
          memcmp: {
            bytes: "ZoV7s83c7bd",
            offset: 0,
          },
        },
      ]
    );
    return subscriptionId;
  }

  public lookupTableKey(data: any): web3.PublicKey {
    const lutSigner = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("LutSigner"), this.pubkey.toBuffer()],
      this.program.programId
    )[0];

    const [_, lutKey] = web3.AddressLookupTableProgram.createLookupTable({
      authority: lutSigner,
      payer: web3.PublicKey.default,
      recentSlot: data.lutSlot,
    });
    return lutKey;
  }

  async loadLookupTable(): Promise<web3.AddressLookupTableAccount> {
    // If the lookup table is already loaded, return it
    if (this.lut) return this.lut;

    const data = await this.loadData();
    const lutKey = this.lookupTableKey(data);
    const accnt = await this.program.provider.connection.getAddressLookupTable(
      lutKey
    );
    this.lut = accnt.value!;
    return this.lut!;
  }

  async loadHistoricalValuesCompact(
    data_?: PullFeedAccountData
  ): Promise<CompactResult[]> {
    const data = data_ ?? (await this.loadData());
    const values = data.historicalResults
      .filter((x) => x.slot.gt(new BN(0)))
      .sort((a, b) => a.slot.cmp(b.slot));
    return values;
  }
}
