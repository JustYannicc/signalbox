use opentelemetry_otlp::{LogExporter, MetricExporter, Protocol, SpanExporter, WithExportConfig};
use opentelemetry_sdk::trace::SpanExporter as _;
use std::future::Future;
use std::task::{Context, Poll, Waker};

fn main() {
    let exporter = SpanExporter::builder()
        .with_http()
        .with_endpoint("http://otel-probe.invalid:4318/v1/traces")
        .with_protocol(Protocol::HttpBinary)
        .build()
        .expect("default span client construction failed");
    println!("otel-default-span-client-ok");
    let _logs = LogExporter::builder().with_http().build().expect("default log client construction failed");
    println!("otel-default-log-client-ok");
    let _metrics = MetricExporter::builder().with_http().build().expect("default metric client construction failed");
    println!("otel-default-metric-client-ok");

    // Socket rejection completes immediately, so this proof needs no executor.
    let mut export = Box::pin(exporter.export(Vec::new()));
    match export.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(Err(error)) => {
            let message = error.to_string();
            assert!(message.contains("socket() failed: errno 52"), "{message}");
            println!("otel-host-net-rejection-ok");
        }
        result => panic!("expected immediate host socket rejection, got {result:?}"),
    }
    println!("otel-probe-ok");
}
