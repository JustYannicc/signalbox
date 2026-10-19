use nix::errno::Errno;
use nix::fcntl::AtFlags;
use nix::sys::signal::{pthread_sigmask, SigSet, SigmaskHow, Signal};
use nix::unistd::{faccessat, AccessFlags};
use std::os::fd::AsRawFd;

fn main() {
    let set = std::hint::black_box(SigSet::empty());
    Errno::EINVAL.set();
    assert_eq!(set.wait(), Err(Errno::ENOSYS));
    assert_eq!(Errno::last(), Errno::EINVAL);
    println!("signal-wait-enosys-ok");

    assert_eq!(pthread_sigmask(SigmaskHow::SIG_BLOCK, Some(&set), None), Err(Errno::ENOSYS));
    let mut old = SigSet::empty();
    old.add(Signal::SIGUSR1);
    assert_eq!(pthread_sigmask(SigmaskHow::SIG_SETMASK, None, Some(&mut old)), Err(Errno::ENOSYS));
    assert!(old.contains(Signal::SIGUSR1));
    assert_eq!(SigSet::thread_get_mask(), Err(Errno::ENOSYS));
    assert_eq!(set.thread_swap_mask(SigmaskHow::SIG_SETMASK), Err(Errno::ENOSYS));
    assert_eq!(pthread_sigmask(SigmaskHow::SIG_BLOCK, None, None), Ok(()));
    println!("signal-mask-enosys-and-noop-ok");

    let directory = "/tmp/signalbox-nix-probe";
    std::fs::create_dir_all(directory).unwrap();
    let existing = format!("{directory}/existing");
    let missing = format!("{directory}/missing");
    std::fs::write(&existing, b"Emscripten memory filesystem fixture").unwrap();
    assert_eq!(faccessat(None, existing.as_str(), AccessFlags::F_OK, AtFlags::empty()), Ok(()));
    assert_eq!(faccessat(None, missing.as_str(), AccessFlags::F_OK, AtFlags::empty()), Err(Errno::ENOENT));
    assert_eq!(Errno::last(), Errno::ENOENT);
    println!("faccessat-existing-missing-errno-ok");

    let fd = std::fs::File::open(directory).unwrap();
    assert_eq!(faccessat(Some(fd.as_raw_fd()), "existing", AccessFlags::R_OK, AtFlags::AT_EACCESS), Ok(()));
    assert_eq!(faccessat(Some(fd.as_raw_fd()), "missing", AccessFlags::F_OK, AtFlags::AT_EACCESS), Err(Errno::ENOENT));
    println!("faccessat-relative-dirfd-eaccess-ok");
    println!("nix-probe-ok");
}
