use crate::AmdSevSnpAttestation;
use anyhow::Error as AnyhowError;
use sev_snp_utilities::guest::attestation::report::AttestationReport;
use sev_snp_utilities::{Policy, Verification};
use sha2::{Digest, Sha256};

impl AmdSevSnpAttestation {
    /// Verify the attestation report
    /// If message is empty skip the message verification
    pub async fn verify(
        report: &AttestationReport,
        message: Option<&[u8]>,
    ) -> Result<(), AnyhowError> {
        // Create strict policy for verification
        // let policy = Policy::strict();
        let policy = Policy::new(
            true,  // require_no_debug,
            true,  // require_no_ma,
            false, // require_no_smt,
            false, // require_id_key,
            false, // require_author_key,
        );

        // Verify report against policy
        report
            .verify(Some(policy))
            .await
            .map_err(|e| AnyhowError::msg(format!("Report verification failed: {}", e)))?;

        // If message is provided, verify it matches the report
        if let Some(msg) = message {
            let mut hasher = Sha256::new();
            hasher.update(msg);
            let msg_hash = hasher.finalize();
            //
            // Verify message hash matches report data
            if report.report_data[..] != msg_hash[..] {
                return Err(AnyhowError::msg(
                        "Message verification failed: hash mismatch",
                ));
            }
        }

        Ok(())
    }
}
