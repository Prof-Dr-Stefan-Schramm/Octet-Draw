// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), crates/io/src/geometry/worker.rs, MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
//! Framed self-executable worker. Rust geometry runs only in this process.
use super::{client, wire};
use std::io::{self, Read, Write};

fn operation() -> Result<octet_geometry::Response, String> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(wire::MAX_REQUEST_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let request: wire::Request = wire::decode(&bytes, wire::MAX_REQUEST_BYTES)?;
    solve(request)
}

pub(super) fn solve(request: wire::Request) -> Result<octet_geometry::Response, String> {
    if request.heap_bytes == 0 || request.heap_bytes > client::MAX_HEAP_BYTES {
        return Err("Invalid geometry heap budget".into());
    }
    let capacity = resolved_capacity(request.heap_bytes, request.capacity)?;
    request.operation.validate_capacity(capacity)?;
    let response = octet_geometry::solve(&request.operation)?;
    if response.coordinates.len() > capacity.coordinates {
        return Err("Geometry result exceeds its machine-budget coordinate capacity".into());
    }
    Ok(response)
}

fn resolved_capacity(
    heap_bytes: usize,
    requested: Option<octet_geometry::Capacity>,
) -> Result<octet_geometry::Capacity, String> {
    let memory_capacity = octet_geometry::Capacity::for_heap(heap_bytes);
    let capacity = requested.unwrap_or_else(|| {
        let legacy = octet_geometry::Capacity::default();
        octet_geometry::Capacity {
            atoms: legacy.atoms.min(memory_capacity.atoms),
            bonds: legacy.bonds.min(memory_capacity.bonds),
            coordinates: legacy.coordinates.min(memory_capacity.coordinates),
        }
    });
    capacity.validate()?;
    if capacity.atoms > memory_capacity.atoms
        || capacity.bonds > memory_capacity.bonds
        || capacity.coordinates > memory_capacity.coordinates
    {
        return Err("Geometry capacity exceeds its heap-budget envelope".into());
    }
    Ok(capacity)
}

/// The worker process: one framed request from stdin, solved on a thread with an 8 MiB stack, one framed response on
/// stdout. Returns the exit code. A crash or abort gives a non-zero exit, which the parent reports.
pub fn run() -> i32 {
    let result = std::thread::Builder::new()
        .name("geometry-operation".into())
        .stack_size(8 * 1024 * 1024)
        .spawn(operation)
        .map_err(|e| format!("Could not start geometry operation: {e}"))
        .and_then(|thread| {
            thread
                .join()
                .map_err(|_| "Geometry operation panicked".to_owned())?
        });
    let response = wire::Response {
        version: octet_geometry::VERSION.into(),
        result,
    };
    match wire::encode(&response, wire::MAX_RESPONSE_BYTES) {
        Ok(bytes) => {
            let mut out = io::stdout().lock();
            if out.write_all(&bytes).and_then(|()| out.flush()).is_err() {
                return 1;
            }
            0
        }
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_capacity_and_explicit_capacity_cannot_bypass_the_heap_envelope() {
        let low = octet_geometry::Capacity::for_heap(64 * 1024 * 1024);
        assert_eq!(resolved_capacity(64 * 1024 * 1024, None).unwrap(), low);
        assert!(resolved_capacity(64 * 1024 * 1024, Some(octet_geometry::Capacity::default())).is_err());
        let high = octet_geometry::Capacity::for_heap(512 * 1024 * 1024);
        assert_eq!(resolved_capacity(512 * 1024 * 1024, Some(high)).unwrap(), high);
        assert_eq!(resolved_capacity(512 * 1024 * 1024, None).unwrap(), octet_geometry::Capacity::default());
        assert!(resolved_capacity(512 * 1024 * 1024, Some(octet_geometry::Capacity { atoms: 0, ..high })).is_err());
    }
}
