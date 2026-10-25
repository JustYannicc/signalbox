//! agentOS wasm32-wasip1: best-effort no-follow filesystem operations over std::fs.
//! WASI preview 1 has no O_NOFOLLOW-by-fd walk from "/", and the agentOS VM is itself
//! the sandbox, so this checks for symlinks with `symlink_metadata` instead.
use crate::FileMetadata;
use std::io;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

fn reject_symlink(path: &Path) -> io::Result<std::fs::Metadata> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains a symbolic link",
        ));
    }
    Ok(metadata)
}

fn ms(time: io::Result<SystemTime>) -> i64 {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

pub(super) fn open_file_sync(path: &Path) -> io::Result<std::fs::File> {
    let metadata = reject_symlink(path)?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path is not a regular file",
        ));
    }
    std::fs::File::open(path)
}

pub(super) async fn write_file(path: PathBuf, contents: Vec<u8>) -> io::Result<()> {
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "path contains a symbolic link",
            ));
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "path is not a regular file",
            ));
        }
        _ => {}
    }
    let mut file = std::fs::File::create(&path)?;
    file.write_all(&contents)
}

pub(super) async fn metadata(path: PathBuf) -> io::Result<FileMetadata> {
    let metadata = std::fs::symlink_metadata(&path)?;
    Ok(FileMetadata {
        is_directory: metadata.is_dir(),
        is_file: metadata.is_file(),
        is_symlink: metadata.file_type().is_symlink(),
        size: metadata.len(),
        created_at_ms: ms(metadata.created()),
        modified_at_ms: ms(metadata.modified()),
    })
}

pub(super) async fn create_directory(path: PathBuf, recursive: bool) -> io::Result<()> {
    if recursive {
        std::fs::create_dir_all(path)
    } else {
        std::fs::create_dir(path)
    }
}

pub(super) async fn remove(path: PathBuf, recursive: bool, force: bool) -> io::Result<()> {
    if recursive {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "recursive no-follow removal is unsupported",
        ));
    }
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if force && error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains a symbolic link",
        ));
    }
    if metadata.is_dir() {
        std::fs::remove_dir(path)
    } else {
        std::fs::remove_file(path)
    }
}
