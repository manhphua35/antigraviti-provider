use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=payload/payload.br");
    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by cargo"));
    let data = fs::read("payload/payload.br").unwrap_or_default();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in &data {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    fs::write(out.join("payload.bin"), &data).expect("payload copy");
    println!("cargo:rustc-env=PAYLOAD_ID={hash:016x}");
}
