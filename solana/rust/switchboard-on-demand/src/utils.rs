use crate::anchor_traits::*;
use solana_program::hash;
use solana_program::instruction::Instruction;
use solana_program::pubkey;
use solana_program::pubkey::Pubkey;

pub const SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID: Pubkey =
    pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

pub const SPL_TOKEN_PROGRAM_ID: Pubkey =
    pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

pub fn find_associated_token_address(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    let (akey, _bump) = Pubkey::find_program_address(
        &[owner.as_ref(), SPL_TOKEN_PROGRAM_ID.as_ref(), mint.as_ref()],
        &SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
    );
    akey
}

pub fn get_ixn_discriminator(ixn_name: &str) -> [u8; 8] {
    let preimage = format!("global:{}", ixn_name);
    let mut sighash = [0u8; 8];
    sighash.copy_from_slice(&solana_program::hash::hash(preimage.as_bytes()).to_bytes()[..8]);
    sighash
}

pub fn get_account_discriminator(account_name: &str) -> [u8; 8] {
    let id = format!("account:{}", account_name);
    hash::hash(id.as_bytes()).to_bytes()[..8]
        .try_into()
        .unwrap()
}

pub fn build_ix<A: ToAccountMetas, I: InstructionData + Discriminator + std::fmt::Debug>(
    program_id: &Pubkey,
    accounts: &A,
    params: &I,
) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: accounts.to_account_metas(None),
        data: params.data(),
    }
}
