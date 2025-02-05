use crate::AmdSevSnpAttestation;
use anyhow::Error as AnyhowError;
use sev_snp_utilities::guest::attestation::report::AttestationReport;
use sev_snp_utilities::Verification;
use sha2::{Digest, Sha256};

impl AmdSevSnpAttestation {
    /// Verify the attestation report
    /// If message is empty skip the message verification
    pub async fn verify(
        report: &AttestationReport,
        message: Option<&[u8]>,
    ) -> Result<(), AnyhowError> {
        if let Some(message) = message {
            let msg = Sha256::digest(message).to_vec();
            let msg = hex::encode(msg).into_bytes();
            if msg != report.report_data {
                return Err(AnyhowError::msg("Report data mismatch"));
            }
        }
        let policy = sev_snp_utilities::Policy::strict();
        report.verify(Some(policy)).await?;
        Ok(())
    }
}
