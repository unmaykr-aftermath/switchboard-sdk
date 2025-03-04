use crate::Gateway;
use crate::OracleAccountData;
use crate::State;
use crate::*;
use anyhow_ext::anyhow;
use anyhow_ext::Context;
use anyhow_ext::Error as AnyhowError;
use associated_token_account::get_associated_token_address;
use associated_token_account::NATIVE_MINT;
use associated_token_account::SPL_TOKEN_PROGRAM_ID;
use base64::{engine::general_purpose::STANDARD as base64, Engine as _};
use bs58;
use bytemuck;
use dashmap::DashMap;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use solana_client::nonblocking::rpc_client::RpcClient;
#[cfg(not(feature = "solana_sdk_1_16"))]
use solana_sdk::address_lookup_table::AddressLookupTableAccount;
#[cfg(feature = "solana_sdk_1_16")]
use solana_sdk::address_lookup_table_account::AddressLookupTableAccount;
use solana_sdk::instruction::AccountMeta;
use solana_sdk::instruction::Instruction;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::system_program;
use std::result::Result;
use std::sync::Arc;
use tokio::join;
use tokio::sync::OnceCell;
use sha2::{Digest, Sha256};
use solana_sdk::secp256k1_program;
use solana_sdk::secp256k1_instruction::DATA_START;
use solana_sdk::secp256k1_instruction::SecpSignatureOffsets;
use solana_sdk::secp256k1_instruction::SIGNATURE_SERIALIZED_SIZE;
use solana_sdk::secp256k1_instruction::construct_eth_pubkey;

type LutCache = DashMap<Pubkey, AddressLookupTableAccount>;
type JobCache = DashMap<[u8; 32], OnceCell<Vec<OracleJob>>>;
type PullFeedCache = DashMap<Pubkey, OnceCell<PullFeedAccountData>>;

pub fn generate_combined_checksum(
    queue_key: &[u8; 32],
    feeds: &[PullFeedAccountData],
    signed_slothash: &[u8; 32],
    submission_values: &[i128],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(queue_key);

    for feed in feeds {
        hasher.update(&feed.feed_hash);
        hasher.update(feed.max_variance.to_le_bytes());
        hasher.update(feed.min_responses.to_le_bytes());
    }

    hasher.update(signed_slothash);
    for &value in submission_values {
        hasher.update(value.to_le_bytes());
    }

    // Finalize and return the hash.
    hasher.finalize().into()
}

pub fn new_secp256k1_instruction(
    secp_key: &libsecp256k1::PublicKey,
    message_arr: &[u8],
    signature_arr: &[u8],
    recovery_id: u8,
) -> Result<Instruction, AnyhowError> {
    let eth_pubkey = construct_eth_pubkey(secp_key);
    let mut hasher = sha3::Keccak256::new();
    hasher.update(message_arr);
    let message_hash = hasher.finalize();
    let mut message_hash_arr = [0u8; 32];
    message_hash_arr.copy_from_slice(message_hash.as_slice());
    let message = libsecp256k1::Message::parse(&message_hash_arr);
    assert_eq!(signature_arr.len(), SIGNATURE_SERIALIZED_SIZE);

    let instruction_data_len = DATA_START
        .saturating_add(eth_pubkey.len())
        .saturating_add(signature_arr.len())
        .saturating_add(message_arr.len())
        .saturating_add(1);
    let mut instruction_data = vec![0; instruction_data_len];

    let eth_address_offset = DATA_START;
    instruction_data[eth_address_offset..eth_address_offset.saturating_add(eth_pubkey.len())]
        .copy_from_slice(&eth_pubkey);

    let signature_offset = DATA_START.saturating_add(eth_pubkey.len());
    instruction_data[signature_offset..signature_offset.saturating_add(signature_arr.len())]
        .copy_from_slice(&signature_arr);

    instruction_data[signature_offset.saturating_add(signature_arr.len())] =
        recovery_id;

    let message_data_offset = signature_offset
        .saturating_add(signature_arr.len())
        .saturating_add(1);
    instruction_data[message_data_offset..].copy_from_slice(message_arr);

    let num_signatures = 1;
    instruction_data[0] = num_signatures;
    let offsets = SecpSignatureOffsets {
        signature_offset: signature_offset as u16,
        signature_instruction_index: 0,
        eth_address_offset: eth_address_offset as u16,
        eth_address_instruction_index: 0,
        message_data_offset: message_data_offset as u16,
        message_data_size: message_arr.len() as u16,
        message_instruction_index: 0,
    };
    let writer = std::io::Cursor::new(&mut instruction_data[1..DATA_START]);
    bincode::serialize_into(writer, &offsets).unwrap();

    Ok(Instruction {
        program_id: solana_sdk::secp256k1_program::id(),
        accounts: vec![],
        data: instruction_data,
    })
}

pub struct SbContext {
    pub lut_cache: LutCache,
    pub job_cache: JobCache,
    pub pull_feed_cache: PullFeedCache,
}
impl SbContext {
    pub fn new() -> Arc<Self> {
        Arc::new(SbContext {
            lut_cache: DashMap::new(),
            job_cache: DashMap::new(),
            pull_feed_cache: DashMap::new(),
        })
    }
}

pub async fn fetch_and_cache_luts<T: bytemuck::Pod + lut_owner::LutOwner>(
    client: &RpcClient,
    context: Arc<SbContext>,
    oracle_keys: &[Pubkey],
) -> Result<Vec<AddressLookupTableAccount>, AnyhowError> {
    let mut luts = Vec::new();
    let mut keys_to_fetch = Vec::new();

    for &key in oracle_keys {
        if let Some(cached_lut) = context.lut_cache.get(&key) {
            luts.push(cached_lut.clone());
        } else {
            keys_to_fetch.push(key);
        }
    }

    if !keys_to_fetch.is_empty() {
        let fetched_luts = load_lookup_tables::<T>(client, &keys_to_fetch).await?;
        for (key, lut) in keys_to_fetch.into_iter().zip(fetched_luts.into_iter()) {
            context.lut_cache.insert(key, lut.clone());
            luts.push(lut);
        }
    }

    Ok(luts)
}

#[derive(Clone, Debug)]
pub struct OracleResponse {
    pub value: Option<Decimal>,
    pub error: String,
    pub oracle: Pubkey,
    pub signature: [u8; 64],
    pub recovery_id: u8,
}

#[derive(Clone, Debug, Default)]
pub struct FetchUpdateParams {
    pub feed: Pubkey,
    pub payer: Pubkey,
    pub gateway: Gateway,
    pub crossbar: Option<CrossbarClient>,
    pub num_signatures: Option<u32>,
    pub debug: Option<bool>,
}

#[derive(Clone, Debug, Default)]
pub struct FetchUpdateManyParams {
    pub feeds: Vec<Pubkey>,
    pub payer: Pubkey,
    pub gateway: Gateway,
    pub crossbar: Option<CrossbarClient>,
    pub num_signatures: Option<u32>,
    pub debug: Option<bool>,
}

#[derive(Clone, Debug, Default)]
pub struct FetchUpdateBatchParams {
    pub feeds: Vec<Pubkey>,
    pub payer: Pubkey,
    pub gateway: Gateway,
    pub crossbar: Option<CrossbarClient>,
    pub num_signatures: Option<u32>,
    pub debug: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SolanaSubmitSignaturesParams {
    pub queue: Pubkey,
    pub feed: Pubkey,
    pub payer: Pubkey,
}

pub struct PullFeed;

impl PullFeed {
    pub async fn load_data(
        client: &RpcClient,
        key: &Pubkey,
    ) -> Result<PullFeedAccountData, AnyhowError> {
        let account = client
            .get_account_data(key)
            .await
            .map_err(|_| anyhow!("PullFeed.load_data: Account not found"))?;
        let account = account[8..].to_vec();
        let data = bytemuck::try_from_bytes::<PullFeedAccountData>(&account)
            .map_err(|_| anyhow!("PullFeed.load_data: Failed to parse data"))?;
        Ok(*data)
    }

    fn get_solana_submit_signatures_ix(
        slot: u64,
        responses: Vec<OracleResponse>,
        params: SolanaSubmitSignaturesParams,
    ) -> Result<Instruction, AnyhowError> {
        let mut submissions = Vec::new();
        for resp in &responses {
            let mut value_i128 = i128::MAX;
            if let Some(mut val) = resp.value {
                val.rescale(18);
                value_i128 = val.mantissa();
            }
            submissions.push(Submission {
                value: value_i128,
                signature: resp.signature,
                recovery_id: resp.recovery_id,
                offset: 0,
            });
        }
        let mut remaining_accounts = Vec::new();
        for resp in &responses {
            remaining_accounts.push(AccountMeta::new_readonly(resp.oracle, false));
        }
        for resp in responses {
            let stats_key = OracleAccountData::stats_key(&resp.oracle);
            remaining_accounts.push(AccountMeta::new(stats_key, false));
        }
        let mut submit_ix = Instruction {
            program_id: *SWITCHBOARD_ON_DEMAND_PROGRAM_ID,
            data: PullFeedSubmitResponseParams { slot, submissions }.data(),
            accounts: PullFeedSubmitResponse {
                feed: params.feed,
                queue: params.queue,
                program_state: State::key(),
                recent_slothashes: solana_sdk::sysvar::slot_hashes::ID,
                payer: params.payer,
                system_program: system_program::ID,
                reward_vault: get_associated_token_address(&params.queue, &NATIVE_MINT),
                token_program: *SPL_TOKEN_PROGRAM_ID,
                token_mint: *NATIVE_MINT,
            }
            .to_account_metas(None),
        };
        submit_ix.accounts.extend(remaining_accounts);
        Ok(submit_ix)
    }

    pub async fn fetch_update_ix(
        context: Arc<SbContext>,
        client: &RpcClient,
        params: FetchUpdateParams,
    ) -> Result<
        (
            Instruction,
            Vec<OracleResponse>,
            usize,
            Vec<AddressLookupTableAccount>,
        ),
        AnyhowError,
    > {
        let latest_slot = SlotHashSysvar::get_latest_slothash(client)
            .await
            .context("PullFeed.fetchUpdateIx: Failed to fetch latest slot")?;

        let feed_data = *context
            .pull_feed_cache
            .entry(params.feed)
            .or_insert_with(OnceCell::new)
            .get_or_try_init(|| PullFeed::load_data(client, &params.feed))
            .await?;

        let feed_hash = feed_data.feed_hash;
        let jobs = context
            .job_cache
            .entry(feed_hash)
            .or_insert_with(OnceCell::new)
            .get_or_try_init(|| {
                let crossbar = params.crossbar.clone().unwrap_or_default();
                async move {
                    let jobs_data = crossbar
                        .fetch(&hex::encode(feed_hash))
                        .await
                        .context("PullFeed.fetchUpdateIx: Failed to fetch jobs")?;

                    let jobs: Vec<OracleJob> =
                        serde_json::from_value(jobs_data.get("jobs").unwrap().clone())
                            .context("PullFeed.fetchUpdateIx: Failed to deserialize jobs")?;

                    Ok::<Vec<OracleJob>, AnyhowError>(jobs)
                }
            })
            .await?
            .clone();

        let encoded_jobs = encode_jobs(&jobs);
        let gateway = params.gateway;

        let num_signatures = if params.num_signatures.is_none() {
            (feed_data.min_sample_size as f64 + ((feed_data.min_sample_size as f64) / 3.0).ceil())
                as u32
        } else {
            params.num_signatures.unwrap()
        };

        let price_signatures = gateway
            .fetch_signatures_from_encoded(FetchSignaturesParams {
                recent_hash: Some(bs58::encode(latest_slot.hash).into_string()),
                encoded_jobs: encoded_jobs.clone(),
                num_signatures,
                max_variance: Some((feed_data.max_variance / 1_000_000_000) as u32),
                min_responses: Some(feed_data.min_responses),
                use_timestamp: Some(false),
            })
            .await
            .context("PullFeed.fetchUpdateIx: Failed to fetch signatures")?;

        let mut num_successes = 0;
        let oracle_responses: Vec<OracleResponse> = price_signatures
            .responses
            .iter()
            .map(|x| {
                let value = x.success_value.parse::<i128>().ok();
                let mut formatted_value = None;
                if let Some(val) = value {
                    num_successes += 1;
                    formatted_value = Some(Decimal::from_i128_with_scale(val, 18));
                }
                OracleResponse {
                    value: formatted_value,
                    error: x.failure_error.clone(),
                    oracle: Pubkey::new_from_array(
                        hex::decode(x.oracle_pubkey.clone())
                            .unwrap()
                            .try_into()
                            .unwrap(),
                    ),
                    recovery_id: x.recovery_id as u8,
                    signature: base64
                        .decode(x.signature.clone())
                        .unwrap_or_default()
                        .try_into()
                        .unwrap_or([0; 64]),
                }
            })
            .collect();

        if params.debug.unwrap_or(false) {
            println!("priceSignatures: {:?}", price_signatures);
        }

        if num_successes == 0 {
            return Err(anyhow_ext::Error::msg(
                "PullFeed.fetchUpdateIx Failure: No successful responses".to_string(),
            ));
        }

        let submit_signatures_ix = PullFeed::get_solana_submit_signatures_ix(
            latest_slot.slot,
            oracle_responses.clone(),
            SolanaSubmitSignaturesParams {
                feed: params.feed,
                queue: feed_data.queue,
                payer: params.payer,
            },
        )
        .context("PullFeed.fetchUpdateIx: Failed to create submit signatures instruction")?;

        let oracle_keys: Vec<Pubkey> = oracle_responses.iter().map(|x| x.oracle).collect();
        let feed_key = [params.feed];
        let queue_key = [feed_data.queue];

        let (oracle_luts, pull_feed_lut, queue_lut) = join!(
            fetch_and_cache_luts::<OracleAccountData>(client, context.clone(), &oracle_keys),
            fetch_and_cache_luts::<PullFeedAccountData>(client, context.clone(), &feed_key),
            fetch_and_cache_luts::<QueueAccountData>(client, context.clone(), &queue_key)
        );
        let oracle_luts = oracle_luts?;
        let pull_feed_lut = pull_feed_lut?;
        let queue_lut = queue_lut?;

        let mut luts = oracle_luts;
        luts.extend(pull_feed_lut);
        luts.extend(queue_lut);

        Ok((submit_signatures_ix, oracle_responses, num_successes, luts))
    }

    /// Fetch the oracle responses and format them into a Solana instruction.
    /// Also fetches relevant lookup tables for the instruction.
    /// This is much like fetch_update_ix method, but for multiple feeds at once.
    /// # Arguments
    /// * `client` - The RPC client
    /// * `params` - The parameters for the fetch
    pub async fn fetch_update_consensus_ix(
        context: Arc<SbContext>,
        client: &RpcClient,
        params: FetchUpdateManyParams,
    ) -> Result<(Vec<Instruction>, Vec<AddressLookupTableAccount>), AnyhowError> {
        let gateway = params.gateway;
        let mut num_signatures = params.num_signatures.unwrap_or(1);
        let mut feed_configs = Vec::new();
        let mut queue = Pubkey::default();

        for feed in &params.feeds {
            let data = *context
                .pull_feed_cache
                .entry(*feed)
                .or_insert_with(OnceCell::new)
                .get_or_try_init(|| PullFeed::load_data(client, feed))
                .await?;
            let num_sig_lower_bound =
                data.min_sample_size as u32 + ((data.min_sample_size as f64) / 3.0).ceil() as u32;
            if num_signatures < num_sig_lower_bound {
                num_signatures = num_sig_lower_bound;
            }
            queue = data.queue;
            let jobs = context
                .job_cache
                .entry(data.feed_hash)
                .or_insert_with(OnceCell::new)
                .get_or_try_init(|| {
                    let crossbar = params.crossbar.clone().unwrap_or_default();
                    async move {
                        let jobs_data = crossbar
                            .fetch(&hex::encode(data.feed_hash))
                            .await
                            .context("PullFeed.fetchUpdateIx: Failed to fetch jobs")?;

                        let jobs: Vec<OracleJob> =
                            serde_json::from_value(jobs_data.get("jobs").unwrap().clone())
                                .context("PullFeed.fetchUpdateIx: Failed to deserialize jobs")?;

                        Ok::<Vec<OracleJob>, AnyhowError>(jobs)
                    }
                })
                .await?
                .clone();
            let encoded_jobs = encode_jobs(&jobs);
            let max_variance = (data.max_variance / 1_000_000_000) as u32;
            let min_responses = data.min_responses;
            let feed_config = FeedConfig {
                encoded_jobs,
                max_variance: Some(max_variance),
                min_responses: Some(min_responses),
            };
            feed_configs.push(feed_config);
        }
        let latest_slot = SlotHashSysvar::get_latest_slothash(client)
            .await
            .context("PullFeed.fetchUpdateIx: Failed to fetch latest slot")?;
        let price_signatures = gateway
            .fetch_signatures_multi(FetchSignaturesMultiParams {
                recent_hash: Some(bs58::encode(latest_slot.hash).into_string()),
                num_signatures: Some(num_signatures),
                feed_configs,
                use_timestamp: Some(false),
            })
            .await
            .context("PullFeed.fetchUpdateIx: fetch signatures failure")?;
        if params.debug.unwrap_or(false) {
            println!("priceSignatures: {:?}", price_signatures);
        }

        let mut submissions: Vec<MultiSubmission> = Vec::new();
        for x in &price_signatures.oracle_responses {
            submissions.push(MultiSubmission {
                values: x
                    .feed_responses
                    .iter()
                    .map(|x| x.success_value.parse().unwrap_or(i128::MAX))
                    .collect(),
                signature: base64
                    .decode(x.signature.clone())
                    .context("base64:decode failure")?
                    .try_into()
                    .map_err(|_| anyhow!("base64:decode failure"))?,
                recovery_id: x.recovery_id as u8,
            });
        }
        let ix_data = PullFeedSubmitResponseManyParams {
            slot: latest_slot.slot,
            submissions,
        };
        let mut remaining_accounts = Vec::new();
        let oracle_keys: Vec<Pubkey> = price_signatures
            .oracle_responses
            .iter()
            .map(|x| {
                Pubkey::new_from_array(
                    hex::decode(x.feed_responses.first().unwrap().oracle_pubkey.clone())
                        .unwrap_or_default()
                        .try_into()
                        .unwrap(),
                )
            })
            .collect();
        for feed in &params.feeds {
            remaining_accounts.push(AccountMeta::new(*feed, false));
        }
        for oracle in oracle_keys.iter() {
            remaining_accounts.push(AccountMeta::new_readonly(*oracle, false));
            let stats_key = OracleAccountData::stats_key(oracle);
            remaining_accounts.push(AccountMeta::new(stats_key, false));
        }

        let queue_key = [queue];
        let (oracle_luts_result, pull_feed_luts_result, queue_lut_result) = join!(
            fetch_and_cache_luts::<OracleAccountData>(client, context.clone(), &oracle_keys),
            fetch_and_cache_luts::<PullFeedAccountData>(client, context.clone(), &params.feeds),
            fetch_and_cache_luts::<QueueAccountData>(client, context.clone(), &queue_key)
        );

        // Handle the results after they are all awaited
        let oracle_luts = oracle_luts_result?;
        let pull_feed_luts = pull_feed_luts_result?;
        let queue_lut = queue_lut_result?;

        let mut luts = oracle_luts;
        luts.extend(pull_feed_luts);
        luts.extend(queue_lut);

        let mut submit_ix = Instruction {
            program_id: *SWITCHBOARD_ON_DEMAND_PROGRAM_ID,
            data: ix_data.data(),
            accounts: PullFeedSubmitResponseMany {
                queue,
                program_state: State::key(),
                recent_slothashes: solana_sdk::sysvar::slot_hashes::ID,
                payer: params.payer,
                system_program: system_program::ID,
                reward_vault: get_associated_token_address(&queue, &NATIVE_MINT),
                token_program: *SPL_TOKEN_PROGRAM_ID,
                token_mint: *NATIVE_MINT,
            }
            .to_account_metas(None),
        };
        submit_ix.accounts.extend(remaining_accounts);
        let ixs = vec![submit_ix];

        Ok((ixs, luts))
    }
}
