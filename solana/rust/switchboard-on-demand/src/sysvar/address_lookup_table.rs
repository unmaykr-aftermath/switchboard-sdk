use crate::cfg_client;

use solana_program::pubkey;
use solana_program::pubkey::Pubkey;
use crate::ON_DEMAND_DEVNET_PID;
use crate::ON_DEMAND_MAINNET_PID;

const LUT_SIGNER_SEED: &[u8] = b"LutSigner";
const LUT_PROGRAM_ID: Pubkey = pubkey!("AddressLookupTab1e1111111111111111111111111");

pub fn find_lut_signer(k: &Pubkey) -> Pubkey {
    let pid = if cfg!(feature = "devnet") {
        ON_DEMAND_DEVNET_PID
    } else {
        ON_DEMAND_MAINNET_PID
    };
    Pubkey::find_program_address(&[LUT_SIGNER_SEED, k.as_ref()], &pid).0
}

pub fn find_lut_of(k: &Pubkey, lut_slot: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[find_lut_signer(k).as_ref(), lut_slot.to_le_bytes().as_ref()],
        &LUT_PROGRAM_ID,
    )
    .0
}

cfg_client! {
    use crate::OnDemandError;
    use solana_client::nonblocking::rpc_client::RpcClient;
    use solana_sdk::address_lookup_table::state::AddressLookupTable;
    use solana_sdk::address_lookup_table::AddressLookupTableAccount;

    pub async fn fetch(client: &RpcClient, address: &Pubkey) -> Result<AddressLookupTableAccount, OnDemandError> {
        let account = client.get_account_data(address)
            .await
            .map_err(|_| OnDemandError::AddressLookupTableFetchError)?;
        let lut = AddressLookupTable::deserialize(&account)
            .map_err(|_| OnDemandError::AddressLookupTableDeserializeError)?;
        let out = AddressLookupTableAccount {
            key: address.clone(),
            addresses: lut.addresses.iter().cloned().collect(),
        };
        Ok(out)
    }
}
