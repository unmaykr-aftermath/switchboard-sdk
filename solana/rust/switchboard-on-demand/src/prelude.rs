pub use crate::accounts::*;
use crate::cfg_client;
pub use crate::decimal::*;
pub use crate::instructions::*;
pub use crate::types::*;
pub use crate::{SWITCHBOARD_ON_DEMAND_PROGRAM_ID, SWITCHBOARD_PROGRAM_ID};
pub use rust_decimal;
pub use switchboard_common::{
    unix_timestamp, ChainResultInfo, FunctionResult, FunctionResultV0, FunctionResultV1,
    LegacyChainResultInfo, LegacySolanaFunctionResult, SolanaFunctionRequestType,
    SolanaFunctionResult, SolanaFunctionResultV0, SolanaFunctionResultV1, FUNCTION_RESULT_PREFIX,
};
cfg_client! {
    pub use crate::client::*;
    use anchor_client;
    use anchor_client::anchor_lang::solana_program;
}

pub use solana_program::entrypoint::ProgramResult;
pub use solana_program::instruction::{AccountMeta, Instruction};
pub use solana_program::program::{invoke, invoke_signed};
pub use std::result::Result;
