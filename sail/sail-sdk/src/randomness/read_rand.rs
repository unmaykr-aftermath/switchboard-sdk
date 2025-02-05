use rand;
use rand::RngCore;

pub struct TeeRandomness;

impl TeeRandomness {
    pub fn read_rand(num_bytes: u32) -> Vec<u8> {
        let mut buf = vec![0u8; num_bytes as usize];
        rand::thread_rng().fill_bytes(&mut buf);
        buf
    }
}
