use crate::OnDemandError;
use futures::TryFutureExt;
use solana_sdk::clock::Clock;

pub async fn fetch_async(
    client: &solana_client::nonblocking::rpc_client::RpcClient,
) -> std::result::Result<Clock, crate::OnDemandError> {
    let pubkey = solana_sdk::sysvar::clock::id();
    let data = client
        .get_account_data(&pubkey)
        .map_err(|_| OnDemandError::AccountNotFound)
        .await?
        .to_vec();
    bincode::deserialize(&data).map_err(|_| OnDemandError::AccountNotFound)
}
