use borsh::ser::BorshSerialize;
use solana_program::instruction::AccountMeta;
use solana_program::pubkey::Pubkey;

/// Traits pulled out of anchor-lang library to remove dependency conflicts
/// for users.

pub trait Discriminator {
    const DISCRIMINATOR: [u8; 8];
    fn discriminator() -> [u8; 8] {
        Self::DISCRIMINATOR
    }
}

pub trait Owner {
    fn owner() -> Pubkey;
}

pub trait ToAccountMetas {
    /// `is_signer` is given as an optional override for the signer meta field.
    /// This covers the edge case when a program-derived-address needs to relay
    /// a transaction from a client to another program but sign the transaction
    /// before the relay. The client cannot mark the field as a signer, and so
    /// we have to override the is_signer meta field given by the client.
    fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta>;
}

/// Calculates the data for an instruction invocation, where the data is
/// `Sha256(<namespace>:<method_name>)[..8] || BorshSerialize(args)`.
/// `args` is a borsh serialized struct of named fields for each argument given
/// to an instruction.
pub trait InstructionData: Discriminator + BorshSerialize {
    fn data(&self) -> Vec<u8> {
        let mut d = Self::discriminator().to_vec();
        d.append(&mut self.try_to_vec().expect("Should always serialize"));
        d
    }
}
