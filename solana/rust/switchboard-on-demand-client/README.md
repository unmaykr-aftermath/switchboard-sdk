# Switchboard-On-Demand-Client

This crate is designed to interact with Switchboard on-demand, the Crossbar service, and queue gateways.

## Crossbar
A middleman service to fetch oracle jobs from IPFS and to return feed price simulations. This is useful for updating a price constantly instead of sending requests directly to oracles.

## Gateways
The frontend to interact with Switchboard oracles.

## Example

```rust
#[tokio::main]
async fn main() {
    let client = RpcClient::new("https://api.devnet.solana.com".to_string());
    let queue_key = Pubkey::from_str("FfD96yeXs4cxZshoPPSKhSPgVQxLAJUT3gefgh84m1Di").unwrap();
    let feed = Pubkey::from_str("7Zi7LkGGARDKhUEFPBUQDsVZ9L965LPEv2rBRdmSXCWh").unwrap();
    let kp = read_keypair_file("authority.json").unwrap();

    let queue = QueueAccountData::load(&client, &queue_key).await.unwrap();
    let gw = &queue.fetch_gateways(&client).await.unwrap()[0];
    let crossbar = CrossbarClient::default();
    let feed_data = PullFeed::load_data(&client, &feed).await.unwrap();
    let feed_hash = feed_data.feed_hash();

    let simulation = crossbar.simulate_feeds(&[&feed_hash]).await.unwrap();
    println!("simulation: {:#?}", simulation);

    let ctx = SbContext::new();
    let (ix, responses, num_success, luts) = PullFeed::fetch_update_ix(
        ctx.clone(),
        &client,
        FetchUpdateParams {
            feed,
            payer: kp.pubkey(),
            gateway: gw.clone(),
            crossbar: Some(crossbar),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let blockhash = client.get_latest_blockhash().await.unwrap();
    let msg = Message::try_compile(
        &kp.pubkey(),
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
            ComputeBudgetInstruction::set_compute_unit_price(35_000),
            ix.clone()
        ],
        &luts,
        blockhash)
    .unwrap();

    let versioned_tx = VersionedTransaction::try_new(V0(msg), &[&kp]).unwrap();
    let result: Response<RpcSimulateTransactionResult> = client
        .simulate_transaction(&versioned_tx)
        .await
        .unwrap();
    println!("ix: {:#?}", result);
}
```

## Updating many feeds at once
```rust
async fn main() {
    let ctx = SbContext::new();
    let client = RpcClient::new("===".to_string());
    let queue_key = Pubkey::from_str("A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w").unwrap();
    let feed = Pubkey::from_str("FNFejcXENaPgKaCTfstew9vSSvdQPnXjGTkJjUnnYvHU").unwrap();
    let kp = read_keypair_file("authority.json").unwrap();

    let queue = QueueAccountData::load(&client, &queue_key).await.unwrap();
    let gw = &queue.fetch_gateways(&client).await.unwrap()[0];
    let crossbar = CrossbarClient::default();
    let feed_data = PullFeed::load_data(&client, &feed).await.unwrap();
    // Batch example
    let jobs = feed_data.fetch_jobs(&crossbar).await.unwrap();
    let slothash = SlotHashSysvar::get_latest_slothash(&client).await.unwrap();
    let batch_fetch = gw.fetch_signatures_batch(FetchSignaturesBatchParams {
        recent_hash: Some(slothash.to_base58_hash()),
        feed_configs: vec![into_batch_request(&feed_data, &jobs)],
        num_signatures: Some(3),
        ..Default::default()
    }).await.unwrap();
    let (ixs, luts) = PullFeed::fetch_batch_update_ixs(ctx, &client, FetchUpdateBatchParams {
        feeds: vec![feed, feed],
        payer: kp.pubkey(),
        gateway: gw.clone(),
        crossbar: Some(crossbar),
        num_signatures: Some(3),
        ..Default::default()
    }).await.unwrap();
    println!("batch_fetch: {:?}", ixs);
}
```
