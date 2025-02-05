use crate::AmdSevSnpAttestation;
use crate::COCO_ATTEST_URL;
use anyhow::Context;
use anyhow::Error as AnyhowError;
use serde_json::Value;
use sev::firmware::guest::AttestationReport as ReprAttestationReport;
use sev_snp_utilities::guest::attestation::report::AttestationReport as LitAttestationReport;
// use sev_snp_utilities::BuildVersion;
// use sev_snp_utilities::FamilyId;
// use sev_snp_utilities::ImageId;
// use sev_snp_utilities::LaunchDigest;
// use sev_snp_utilities::Policy;
// use sev_snp_utilities::Signature;
// use sev_snp_utilities::TcbVersion;
use sha2::{Digest, Sha256};

impl AmdSevSnpAttestation {
    pub async fn attest(message: &[u8]) -> Result<LitAttestationReport, AnyhowError> {
        let serialized = Self::attest_base(message).await?;
        let mut cursor = std::io::Cursor::new(serialized);
        let lit_report = LitAttestationReport::from_reader(&mut cursor).unwrap();
        Ok(lit_report)
    }

    pub async fn attest_base(message: &[u8]) -> Result<Vec<u8>, AnyhowError> {
        let digest = Sha256::digest(message).to_vec();
        let msg = hex::encode(digest);
        let url = format!("{}/aa/evidence?runtime_data={}", COCO_ATTEST_URL, msg);
        let report = reqwest::get(url)
            .await
            .context("Failed to get AMD SEV report")?
            .text()
            .await?;
        let report = serde_json::from_str::<Value>(&report)?;
        let report = &report["attestation_report"];
        let report = serde_json::from_value::<ReprAttestationReport>(report.clone())?;
        let serialized =
            bincode::serialize(&report).context("Failed to serialize AMD SEV report")?;
        Ok(serialized)
    }
}

//
// impl AmdSevSnpAttestationJs {
//
// pub async fn attest(message: &[u8]) -> Result<Vec<u8>, AnyhowError> {
// let digest = Sha256::digest(message).to_vec();
// let msg = hex::encode(digest);
// let url = format!("{}/aa/evidence?runtime_data={}", COCO_ATTEST_URL, msg);
// let report = reqwest::get(url)
// .await?
// .text()
// .await?;
// let report = serde_json::from_str::<Value>(&report)?;
// let report = &report["attestation_report"];
// let report = serde_json::from_value::<ReprAttestationReport>(report.clone())?;
// let serialized = bincode::serialize(&report)?;
// Ok(serialized)
// }
// }

// fn lit_attestation_report_from_json(v: &Value) -> Result<LitAttestationReport, AnyhowError> {
// let mut body = vec![];
// let version: u32 = v["version"].as_u64().unwrap() as u32;
// body.extend_from_slice(version.to_le_bytes());
// let guest_svn: u32 = v["guest_svn"].as_u64().unwrap() as u32;
// body.extend_from_slice(guest_svn.to_le_bytes());
// let policy: u64 = v["guest_policy"].as_u64().unwrap();
// body.extend_from_slice(policy.to_le_bytes());
// let family_id: [u8; 16] = to_vec(&v["family_id"])?.try_into().unwrap();
// body.extend_from_slice(&family_id);
// let image_id: [u8; 16] = to_vec(&v["image_id"])?.try_into().unwrap();
// body.extend_from_slice(&image_id);
// let vmpl: u32 = v["vmpl"].as_u64().unwrap() as u32;
// body.extend_from_slice(vmpl.to_le_bytes());
// let signature_algo: u32 = v["signature_algo"].as_u64().unwrap() as u32;
// body.extend_from_slice(signature_algo.to_le_bytes());
// let platform_version: Vec<u8> = to_vec(&v["platform_version"]).unwrap();
// let platform_info: u64 = v["platform_info"].as_u64().unwrap();
// let flags: u32 = v["flags"].as_u64().unwrap() as u32;
// let report_data: [u8; 64] = to_vec(&v["report_data"])?;
// let measurement: [u8; 48] = to_vec(&v["measurement"])?.try_into().unwrap();
// let host_data: [u8; 32] = to_vec(&v["host_data"])?.try_into().unwrap();
// let id_key_digest: [u8; 48] = to_vec(&v["id_key_digest"])?.try_into().unwrap();
// let author_key_digest: [u8; 48] = to_vec(&v["author_key_digest"])?.try_into().unwrap();
// let report_id: [u8; 32] = to_vec(&v["report_id"])?.try_into().unwrap();
// let report_id_ma: [u8; 32] = to_vec(&v["report_id_ma"])?.try_into().unwrap();
// let reported_tcb: Vec<u8> = to_vec(&v["reported_tcb"]).unwrap()
// let chip_id: [u8; 64] = to_vec(&v["chip_id"])?.try_into().unwrap();
// let committed_tcb = TcbVersion::from_reader(&mut to_vec(&v["committed_tcb"])).unwrap();
// let current_build = BuildVersion::from_reader(&mut to_vec(&v["current_build"])).unwrap();
// let committed_build = BuildVersion::from_reader(&mut to_vec(&v["committed_build"])).unwrap();
// let launch_tcb: TcbVersion = TcbVersion::from_reader(&mut to_vec(&v["launch_tcb"])).unwrap();
// let signature: Signature = ecdsa::EcdsaSig::from_der(&to_vec(&v["signature"]))?.into();
// let report = LitAttestationReport {
// body,
// version,
// guest_svn,
// policy,
// family_id: FamilyId(family_id),
// image_id: ImageId(image_id),
// vmpl,
// signature_algo,
// platform_version,
// platform_info,
// flags,
// report_data,
// measurement: LaunchDigest(measurement),
// host_data: host_data.to_vec(),
// id_key_digest: id_key_digest.to_vec(),
// author_key_digest: author_key_digest.to_vec(),
// report_id: report_id.to_vec(),
// report_id_ma: report_id_ma.to_vec(),
// reported_tcb,
// chip_id: chip_id.to_vec(),
// committed_tcb,
// current_build,
// committed_build,
// launch_tcb,
// signature,
// };
// Ok(report)
// }
//
// fn to_vec(v: &Value) -> Result<Vec<u8>, AnyhowError> {
// let bytes = v.as_array()
// .context("Expected array")?;
// let bytes = bytes.iter().map(|v| v.as_u64().unwrap_or_default() as u8).collect();
// Ok(bytes)
// }
