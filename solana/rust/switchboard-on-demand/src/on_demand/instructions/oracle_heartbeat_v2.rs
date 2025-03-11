use crate::anchor_traits::*;
use crate::cfg_client;
use crate::prelude::*;
use borsh::BorshSerialize;
use solana_program::pubkey::Pubkey;
use solana_program::system_program;
use spl_token;

pub struct OracleHeartbeatV2;

#[derive(Clone, BorshSerialize, Debug)]
pub struct OracleHeartbeatV2Params {
    pub uri: Option<[u8; 64]>,
}

impl InstructionData for OracleHeartbeatV2Params {}

impl Discriminator for OracleHeartbeatV2 {
    const DISCRIMINATOR: [u8; 8] = [122, 231, 66, 32, 226, 62, 144, 103];
}
impl Discriminator for OracleHeartbeatV2Params {
    const DISCRIMINATOR: [u8; 8] = OracleHeartbeat::DISCRIMINATOR;
}

pub struct OracleHeartbeatV2Args {
    pub oracle: Pubkey,
    pub oracle_signer: Pubkey,
    pub queue: Pubkey,
    pub queue_authority: Pubkey,
    pub gc_node: Pubkey,
    pub uri: Option<[u8; 64]>,
    pub payer: Pubkey,
}
pub struct OracleHeartbeatV2Accounts {
    pub oracle: Pubkey,
    pub oracle_signer: Pubkey,
    pub queue: Pubkey,
    pub queue_authority: Pubkey,
    pub gc_node: Pubkey,
    pub payer: Pubkey,
    pub ncn: Pubkey,
    pub operator: Pubkey,
    pub operator_state: Pubkey,
    pub switch_mint: Pubkey,
    pub remaining_accounts: Vec<AccountMeta>,
}
impl ToAccountMetas for OracleHeartbeatV2Accounts {
    fn to_account_metas(&self, _: Option<bool>) -> Vec<AccountMeta> {
        let state_pubkey = State::get_pda();
        // global subsidy vault
        let subsidy_vault = get_associated_token_address(&state_pubkey, &self.switch_mint);
        let oracle_switch_wallet =
            get_associated_token_address(&self.oracle_signer, &self.switch_mint);
        let ata_program = spl_associated_token_account::id()
            .to_string()
            .parse()
            .unwrap();
        let mut accts = vec![
            AccountMeta::new(self.oracle, false),
            AccountMeta::new(OracleAccountData::stats_key(&self.oracle), false),
            AccountMeta::new_readonly(self.oracle_signer, true),
            AccountMeta::new(self.queue, false),
            AccountMeta::new(self.gc_node, false),
            AccountMeta::new(state_pubkey, false),
            AccountMeta::new(self.payer, true),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(spl_token::ID, false),
            AccountMeta::new_readonly(ata_program, false),
            AccountMeta::new_readonly(self.ncn, false),
            AccountMeta::new_readonly(self.operator, false),
            AccountMeta::new_readonly(self.operator_state, false),
            AccountMeta::new_readonly(spl_token::native_mint::ID, false),
            AccountMeta::new_readonly(self.switch_mint, false),
            AccountMeta::new(oracle_switch_wallet, false),
            AccountMeta::new(subsidy_vault, false),
        ];
        accts.extend(self.remaining_accounts.clone());
        accts
    }
}

cfg_client! {
use solana_client::nonblocking::rpc_client::RpcClient;
use jito_restaking_client::programs::JITO_RESTAKING_ID;
use jito_vault_client::programs::JITO_VAULT_ID;
use crate::get_sb_program_id;

impl OracleHeartbeatV2 {
    pub async fn build_ix(client: &RpcClient, args: OracleHeartbeatV2Args) -> Result<Instruction, OnDemandError> {
        let state = State::fetch_async(client).await?;
        let oracle_data = OracleAccountData::fetch_async(client, args.oracle).await?;
        let queue_data = QueueAccountData::fetch_async(client, args.queue).await?;
        let operator = oracle_data.operator;
        let ncn_operator_state = Pubkey::find_program_address(
            &[
                b"ncn_operator_state",
                &queue_data.ncn.to_bytes(),
                &operator.to_bytes(),
            ],
            &JITO_RESTAKING_ID,
        ).0;
        let mut remaining_accounts = Vec::new();
        for vault in &queue_data.vaults {
            if *vault == Pubkey::default() {
                continue;
            }
            let vod = Pubkey::find_program_address(
                &[
                    b"vault_operator_delegation",
                    &vault.to_bytes(),
                    &operator.to_bytes(),
                ],
                &JITO_VAULT_ID,
            ).0;
            // first check if vod exists
            if client.get_account(&vod).await.is_err() {
                continue;
            }
            let ata = get_associated_token_address(&vault, &state.switch_mint);
            remaining_accounts.extend(vec![
                AccountMeta::new(ata, false),
                AccountMeta::new_readonly(vod, false),
            ]);
        }
        let cluster = std::env::var("CLUSTER").unwrap_or("mainnet".to_string());
        let pid = get_sb_program_id(&cluster);
        let ix = crate::utils::build_ix(
            &pid,
            &OracleHeartbeatV2Accounts {
                oracle: args.oracle,
                oracle_signer: args.oracle_signer,
                queue: args.queue,
                queue_authority: args.queue_authority,
                gc_node: args.gc_node,
                payer: args.payer,
                ncn: queue_data.ncn,
                operator: oracle_data.operator,
                operator_state: ncn_operator_state,
                switch_mint: state.switch_mint,
                remaining_accounts,
            },
            &OracleHeartbeatV2Params { uri: args.uri },
        );
        Ok(ix)
    }
}
}
