//! Synthetic adapter proof only. No Codex, PTY, network or process parity claim.
use std::io;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::time::Duration;

fn main() -> io::Result<()> {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "runtime".into());
    if mode == "unavailable" || mode == "invalid-require" {
        let error = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap_err();
        assert_eq!(error.kind(), if mode == "unavailable" {
            io::ErrorKind::Unsupported
        } else { io::ErrorKind::InvalidData });
        println!("host-rejection-ok");
        return Ok(());
    }
    if mode == "invalid-count" || mode == "interrupted" || mode == "negative-errno" {
        let mut poll = mio::Poll::new()?;
        let error = poll.poll(&mut mio::Events::with_capacity(4), Some(Duration::ZERO)).unwrap_err();
        assert_eq!(error.kind(), if mode == "interrupted" {
            io::ErrorKind::Interrupted
        } else { io::ErrorKind::InvalidData });
        println!("poll-error-ok");
        return Ok(());
    }
    let error = tokio::runtime::Builder::new_multi_thread().build().unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::Unsupported);
    // IO remains disabled: the synthetic host does not implement sockets/signals.
    // Full Cargo features remain enabled and runtime_require still requests 31.
    let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build()?;
    let peer_ran = Arc::new(AtomicBool::new(false));
    runtime.block_on(async {
        let peer_flag = peer_ran.clone();
        let peer = tokio::spawn(async move { peer_flag.store(true, Ordering::SeqCst) });
        let closure_flag = peer_ran.clone();
        let join = tokio::task::spawn_blocking(move || {
            // A finite stand-in for a PTY loop: another guest task has no chance
            // to run while this closure is executing. Never spin waiting on it.
            assert!(!closure_flag.load(Ordering::SeqCst));
            7
        });
        assert!(join.is_finished(), "spawn_blocking did not complete inline");
        assert!(!peer_ran.load(Ordering::SeqCst));
        assert_eq!(join.await.unwrap(), 7);
        peer.await.unwrap();
        assert!(peer_ran.load(Ordering::SeqCst));
        println!("inline-blocking-limitation-confirmed");
        println!("tokio-timer-before");
        tokio::time::sleep(Duration::from_millis(10)).await;
        println!("tokio-timer-after");
    });
    let join = runtime.handle().spawn_blocking(|| 11);
    assert!(join.is_finished());
    assert_eq!(runtime.block_on(join).unwrap(), 11);
    let stale = runtime.handle().clone();
    drop(runtime);
    let cancelled = stale.spawn_blocking(|| panic!("closure ran after runtime shutdown"));
    assert!(cancelled.is_finished());
    let runtime = tokio::runtime::Builder::new_current_thread().build()?;
    assert!(runtime.block_on(cancelled).unwrap_err().is_cancelled());
    drop(runtime);

    let mut poll = mio::Poll::new()?;
    let waker = mio::Waker::new(poll.registry(), mio::Token(17))?;
    let mut events = mio::Events::with_capacity(4);
    waker.wake()?;
    poll.poll(&mut events, None)?;
    let event = events.iter().next().expect("lost wake-before-poll token");
    assert_eq!(event.token(), mio::Token(17));
    assert!(event.is_readable(), "Mio waker event must be readable");
    println!("mio-wake-before-poll-ok");
    println!("mio-timer-before");
    poll.poll(&mut events, Some(Duration::from_millis(10)))?;
    assert!(events.is_empty());
    println!("mio-timer-after");
    drop(waker);
    drop(poll);
    println!("synthetic-runtime-proof-ok");
    Ok(())
}
