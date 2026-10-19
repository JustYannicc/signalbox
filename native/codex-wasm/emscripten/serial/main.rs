use serial2::SerialPort;
use std::io::ErrorKind;
use std::os::fd::OwnedFd;

fn main() {
    let file = std::fs::File::create("/tmp/signalbox-serial-probe").unwrap();
    let fd: OwnedFd = file.into();
    let port = SerialPort::from(fd);
    for enable in std::hint::black_box([true, false]) {
        let error = port.set_break(enable).expect_err("serial break must be unsupported");
        assert_eq!(error.kind(), ErrorKind::Unsupported);
        assert_eq!(error.raw_os_error(), None);
        println!("serial-break-{enable}-unsupported-ok");
    }
    let file = std::fs::File::from(OwnedFd::from(port));
    assert_eq!(file.metadata().unwrap().len(), 0);
    println!("serial-public-owned-fd-ok");
    println!("serial-probe-ok");
}
