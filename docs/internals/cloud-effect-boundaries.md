# Cloud Effect boundaries

Each Cloudflare Durable Object owns one `ManagedRuntime` for its lifetime, built from its services during construction. Each exposed method calls one service method through that runtime; domain logic and typed failures stay in the service, while the method adapts Cloudflare's Promise-shaped request, alarm, or RPC contract.
