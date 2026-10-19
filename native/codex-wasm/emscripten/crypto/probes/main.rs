use ring::rand::{SecureRandom, SystemRandom};

fn main() {
    let rng = SystemRandom::new();
    for size in [0, 1, 256, 257, 65_537] {
        let mut bytes = vec![0; size];
        println!("ring-begin:{size}");
        rng.fill(&mut bytes).expect("Ring entropy unavailable");
        println!("ring-end:{size}");
    }
    let provider = rustls::crypto::ring::default_provider();
    println!("rustls-begin:32");
    provider
        .secure_random
        .fill(&mut [0; 32])
        .expect("Rustls Ring entropy unavailable");
    println!("rustls-end:32");
    println!("ring-entropy-probe-ok");
}
