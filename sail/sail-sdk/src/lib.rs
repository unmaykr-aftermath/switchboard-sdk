pub mod amd_sev_snp_attestation;
pub use amd_sev_snp_attestation::*;
pub mod randomness;
pub use randomness::*;
pub mod keys;
pub use keys::*;

use cached::proc_macro::once;
use reqwest::StatusCode;

#[once]
pub fn check_head_request() -> bool {
    let client = reqwest::blocking::Client::new();

    match client.head(COCO_ATTEST_URL).send() {
        Ok(response) => {
            response.status() == StatusCode::OK || response.status() == StatusCode::NOT_FOUND
        }
        Err(e) => {
            eprintln!("Failed to send HEAD request: {}", e);
            false
        }
    }
}

pub fn is_in_coco() -> bool {
    check_head_request()
}
