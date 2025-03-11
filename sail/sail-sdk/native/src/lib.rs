use tokio::runtime::Runtime;
use sail_sdk::EnclaveKeys;
use sail_sdk::AmdSevSnpAttestation;
use sail_sdk::TeeRandomness;
use neon::prelude::*;

declare_types! {
    pub class JsEnclaveKeys for EnclaveKeys {
        init(_) {
            Ok(EnclaveKeys {})
        }

        // Static method: getDerivedKey
        method getDerivedKey(mut cx) {
            let key = EnclaveKeys::get_derived_key()
                .map_err(|err| cx.throw_error(err.to_string()));
            if let Err(err) = key {
                return err;
            }
            let key = key.unwrap();
            let buffer = JsBuffer::new(&mut cx, key.len() as u32);
            if let Err(err) = buffer {
                return cx.throw_error(err.to_string());
            }
            let mut buffer = buffer.unwrap();
            cx.borrow_mut(&mut buffer, |data| {
                data.as_mut_slice().copy_from_slice(&key);
            });
            Ok(buffer.upcast())
        }

        // Static method: getEnclaveEd25519Keypair
        method getEnclaveEd25519Keypair(mut cx) {
            let keypair = EnclaveKeys::get_enclave_ed25519_keypair()
                .map_err(|err| cx.throw_error(err.to_string()));
            if let Err(err) = keypair {
                return err;
            }
            let keypair = keypair.unwrap();

            let buffer = JsBuffer::new(&mut cx, keypair.len() as u32);
            if let Err(err) = buffer {
                return cx.throw_error(err.to_string());
            }
            let mut buffer = buffer.unwrap();
            cx.borrow_mut(&mut buffer, |data| {
                data.as_mut_slice().copy_from_slice(&keypair);
            });
            Ok(buffer.upcast())
        }

        // Static method: getEnclaveSecp256k1Keypair
        method getEnclaveSecp256k1Keypair(mut cx) {
            let keypair = EnclaveKeys::get_enclave_secp256k1_keypair();
            if let Err(err) = keypair {
                return cx.throw_error(err.to_string());
            }
            let keypair = keypair.unwrap();
            let buffer = JsBuffer::new(&mut cx, keypair.len() as u32);
            if let Err(err) = buffer {
                return cx.throw_error(err.to_string());
            }
            let mut buffer = buffer.unwrap();
            cx.borrow_mut(&mut buffer, |data| {
                data.as_mut_slice().copy_from_slice(&keypair);
            });
            Ok(buffer.upcast())
        }
    }

    pub class JsAmdSevSnpAttestation for AmdSevSnpAttestation {
        init(_) {
            Ok(AmdSevSnpAttestation {})
        }

        // Static method: attest
        method attest(mut cx) {
            let message = cx.argument::<JsBuffer>(0)?;
            let message = cx.borrow(&message, |data| data.as_slice::<u8>().to_vec());
            let message = hex::encode(message);

            let rt = Runtime::new().unwrap();
            let report_result = rt.block_on(AmdSevSnpAttestation::attest_base(&message));
            if let Err(err) = report_result {
                return cx.throw_error(err.to_string());
            }

            let serialized = report_result.unwrap();
            let mut buffer = JsBuffer::new(&mut cx, serialized.len() as u32)?;
            cx.borrow_mut(&mut buffer, |data| {
                data.as_mut_slice().copy_from_slice(&serialized);
            });

            Ok(buffer.upcast())
        }
    }

    pub class JsTeeRandomness for TeeRandomness {
        init(_) {
            Ok(TeeRandomness {})
        }

        // Static method: readRand
        method readRand(mut cx) {
            let num_bytes = cx.argument::<JsNumber>(0)?.value() as u32;

            let random_bytes = TeeRandomness::read_rand(num_bytes);

            let mut buffer = JsBuffer::new(&mut cx, random_bytes.len() as u32)?;
            cx.borrow_mut(&mut buffer, |data| {
                data.as_mut_slice().copy_from_slice(&random_bytes);
            });

            Ok(buffer.upcast())
        }
    }
}

register_module!(mut cx, {
    cx.export_class::<JsEnclaveKeys>("EnclaveKeys")?;
    cx.export_class::<JsAmdSevSnpAttestation>("AmdSevSnpAttestation")?;
    cx.export_class::<JsTeeRandomness>("TeeRandomness")?;
    Ok(())
});

