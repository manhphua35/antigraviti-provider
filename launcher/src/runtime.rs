use crate::paths;
use brotli_decompressor::Decompressor;
use std::env;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

static PAYLOAD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/payload.bin"));
const PAYLOAD_ID: &str = env!("PAYLOAD_ID");
const COMPLETE_MARKER: &str = ".complete";
const BUFFER_SIZE: usize = 1 << 16;

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

fn runtime_base() -> PathBuf {
    env::var_os("LOCALAPPDATA")
        .map(|dir| PathBuf::from(dir).join("AntigravityProvider"))
        .unwrap_or_else(paths::data_dir)
        .join("runtime")
}

fn read_full(reader: &mut impl Read, buffer: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        let read = reader.read(&mut buffer[filled..])?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    Ok(filled)
}

fn safe_relative(name: &str) -> io::Result<PathBuf> {
    let path = Path::new(name);
    if path.components().all(|part| matches!(part, Component::Normal(_))) && !name.is_empty() {
        Ok(path.to_path_buf())
    } else {
        Err(invalid("unsafe path in payload"))
    }
}

fn extract_section(body: &[u8], dest: &Path) -> io::Result<()> {
    let mut reader = Decompressor::new(body, BUFFER_SIZE);
    loop {
        let mut head = [0u8; 2];
        match read_full(&mut reader, &mut head)? {
            0 => return Ok(()),
            2 => {}
            _ => return Err(invalid("truncated entry header")),
        }
        let mut name = vec![0u8; u16::from_le_bytes(head) as usize];
        reader.read_exact(&mut name)?;
        let mut size = [0u8; 8];
        reader.read_exact(&mut size)?;
        let size = u64::from_le_bytes(size);
        let relative = safe_relative(std::str::from_utf8(&name).map_err(|_| invalid("bad file name"))?)?;
        let target = dest.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = File::create(target)?;
        let copied = io::copy(&mut (&mut reader).take(size), &mut file)?;
        if copied != size {
            return Err(invalid("truncated file data"));
        }
    }
}

fn extract(dest: &Path) -> io::Result<()> {
    let mut rest = PAYLOAD;
    while !rest.is_empty() {
        let (head, tail) = rest.split_at_checked(8).ok_or_else(|| invalid("truncated payload"))?;
        let length = u64::from_le_bytes(head.try_into().expect("8 bytes")) as usize;
        let (body, tail) = tail.split_at_checked(length).ok_or_else(|| invalid("truncated section"))?;
        extract_section(body, dest)?;
        rest = tail;
    }
    Ok(())
}

fn prune(base: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(base) else { return };
    let staging = format!("{keep}.tmp");
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name != keep && name != staging.as_str() {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

pub fn prepare() -> io::Result<Option<PathBuf>> {
    if PAYLOAD.is_empty() {
        return Ok(None);
    }
    let base = runtime_base();
    let target = base.join(PAYLOAD_ID);
    if !target.join(COMPLETE_MARKER).is_file() {
        let staging = base.join(format!("{PAYLOAD_ID}.tmp"));
        let _ = fs::remove_dir_all(&staging);
        fs::create_dir_all(&staging)?;
        extract(&staging)?;
        fs::write(staging.join(COMPLETE_MARKER), "")?;
        let _ = fs::remove_dir_all(&target);
        fs::rename(&staging, &target)?;
    }
    prune(&base, PAYLOAD_ID);
    Ok(Some(target))
}
