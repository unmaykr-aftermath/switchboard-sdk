use borsh::BorshSerialize;
use solana_program::pubkey::Pubkey;

use crate::anchor_traits::*;
use crate::cfg_client;
use crate::prelude::*;

pub struct OracleSetConfigs {}

#[derive(Clone, BorshSerialize, Debug)]
pub struct OracleSetConfigsParams {
    pub new_authority: Option<Pubkey>,
    pub new_secp_authority: Option<[u8; 64]>,
}

impl InstructionData for OracleSetConfigsParams {}

impl Discriminator for OracleSetConfigs {
    const DISCRIMINATOR: [u8; 8] = [129, 111, 223, 4, 191, 188, 70, 180];
}
impl Discriminator for OracleSetConfigsParams {
    const DISCRIMINATOR: [u8; 8] = OracleSetConfigs::DISCRIMINATOR;
}

pub struct OracleSetConfigsArgs {
    pub oracle: Pubkey,
    pub authority: Pubkey,
    pub secp_authority: [u8; 64],
}
pub struct OracleSetConfigsAccounts {
    pub oracle: Pubkey,
    pub authority: Pubkey,
}
impl ToAccountMetas for OracleSetConfigsAccounts {
    fn to_account_metas(&self, _: Option<bool>) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(self.oracle, false),
            AccountMeta::new_readonly(self.authority, true),
        ]
    }
}

cfg_client! {
use solana_client::nonblocking::rpc_client::RpcClient;
use crate::get_sb_program_id;

impl OracleSetConfigs {
    pub async fn build_ix(_client: &RpcClient, args: OracleSetConfigsArgs) -> Result<Instruction, OnDemandError> {
        let pid = if cfg!(feature = "devnet") {
            get_sb_program_id("devnet")
        } else {
            get_sb_program_id("mainnet")
        };
        let ix = crate::utils::build_ix(
            &pid,
            &OracleSetConfigsAccounts {
                oracle: args.oracle,
                authority: args.authority,
            },
            &OracleSetConfigsParams {
                new_authority: Some(args.authority),
                new_secp_authority: Some(args.secp_authority),
            },
        );
        Ok(ix)
    }
}
}
