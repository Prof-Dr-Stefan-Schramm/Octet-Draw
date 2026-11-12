// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), crates/io/src/geometry/client.rs, MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
//! Parent side: one request per disposable worker process (this executable with --geometry-worker), with a deadline.
//! The worker is killed at the deadline. Its answer is read as hostile and checked before the page sees it.
use super::wire;
use octet_geometry::{Capacity, Operation, Request, Response};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub(super) const MAX_HEAP_BYTES: usize = 512 * 1024 * 1024;
/// The default envelope: 512 atoms, 2048 bonds, 4096 coordinates.
const HEAP_BYTES: usize = 256 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_STDERR_BYTES: usize = 64 * 1024;
/// Keeps the worker console hidden on Windows.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(super) const NOT_STARTED: &str = "Octet cannot start the 3D calculation.";
pub(super) const TOO_LONG: &str = "The 3D calculation took longer than 60 seconds. Octet stopped it.";
pub(super) const STOPPED: &str = "The 3D calculation stopped before it was complete.";
pub(super) const BAD_ANSWER: &str = "The 3D calculation gave a result that Octet cannot use.";

/// Run one operation in a new worker process.
pub fn execute(operation: Request) -> Result<Response, String> {
    let executable = std::env::current_exe().map_err(|_| NOT_STARTED.to_string())?;
    let mut command = Command::new(executable);
    command.arg("--geometry-worker");
    execute_with(command, operation, TIMEOUT)
}

pub(super) fn execute_with(command: Command, operation: Request, timeout: Duration) -> Result<Response, String> {
    let capacity = Capacity::for_heap(HEAP_BYTES);
    operation.validate_capacity(capacity)?;
    let expected = Expected::of(&operation)?;
    let request = wire::encode(
        &wire::Request { heap_bytes: HEAP_BYTES, capacity: Some(capacity), operation },
        wire::MAX_REQUEST_BYTES,
    )
    .map_err(|_| BAD_ANSWER.to_string())?;
    let bytes = exchange(command, &request, timeout)?;
    check(&bytes, &expected, capacity)
}

/// What the answer must agree with.
pub(super) struct Expected {
    field: octet_geometry::ForceField,
    originals: usize,
    evaluating: bool,
    /// Relax and Evaluate keep the atom count they were given.
    coordinates: Option<usize>,
    fixed: Vec<(usize, [f64; 3])>,
}

impl Expected {
    pub(super) fn of(operation: &Request) -> Result<Self, String> {
        let fixed = operation
            .fixed_atoms
            .iter()
            .map(|&i| operation.coordinates.get(i).map(|&p| (i, p)).ok_or("Missing pinned coordinates"))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Expected {
            field: operation.field,
            originals: operation.atoms.len(),
            evaluating: operation.operation == Operation::Evaluate,
            coordinates: (operation.operation != Operation::Generate).then_some(operation.coordinates.len()),
            fixed,
        })
    }
}

/// ReShiki's response checks (client.rs 224–306): version, force field, finite energies, bounded diagnostics, the
/// atom count and hydrogen parents, pinned atoms unchanged, and the gradient for Evaluate.
pub(super) fn check(bytes: &[u8], expected: &Expected, capacity: Capacity) -> Result<Response, String> {
    let bad = |_| BAD_ANSWER.to_string();
    let response: wire::Response = wire::decode(bytes, wire::MAX_RESPONSE_BYTES).map_err(bad)?;
    if response.version != octet_geometry::VERSION {
        return Err(BAD_ANSWER.into());
    }
    let response = response.result?;
    if response.field != expected.field
        || !response.energy.is_finite()
        || !response.initial_energy.is_finite()
        || response.diagnostics.len() > 100
        || response.diagnostics.iter().any(|s| s.len() > 8192)
    {
        return Err(BAD_ANSWER.into());
    }
    let count = response.coordinates.len();
    if response.original_count != expected.originals
        || count != expected.originals + response.hydrogen_parents.len()
        || response.hydrogen_parents.iter().any(|&p| p >= expected.originals)
        || !response.coordinates.iter().flatten().all(|v| v.is_finite())
        || count > capacity.coordinates
        || expected.coordinates.is_some_and(|n| n != count)
    {
        return Err(BAD_ANSWER.into());
    }
    for &(index, point) in &expected.fixed {
        let actual = response.coordinates.get(index).ok_or(BAD_ANSWER)?;
        if (0..3).any(|k| (actual[k] - point[k]).abs() > 1e-9) {
            return Err(BAD_ANSWER.into());
        }
    }
    if expected.evaluating && response.gradient.is_none() {
        return Err(BAD_ANSWER.into());
    }
    if response
        .gradient
        .as_ref()
        .is_some_and(|g| g.len() != count || !g.iter().flatten().all(|v| v.is_finite()))
    {
        return Err(BAD_ANSWER.into());
    }
    Ok(response)
}

fn read_limited(mut stream: impl Read, limit: usize) -> Option<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = stream.read(&mut buffer).ok()?;
        if count == 0 {
            return Some(output);
        }
        if count > limit.saturating_sub(output.len()) {
            return None;
        }
        output.extend_from_slice(&buffer[..count]);
    }
}

/// Start the worker, write the request, read its answer, and wait for it to end before the deadline.
fn exchange(mut command: Command, request: &[u8], timeout: Duration) -> Result<Vec<u8>, String> {
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let deadline = Instant::now() + timeout;
    let mut child = command.spawn().map_err(|_| NOT_STARTED.to_string())?;
    let (Some(mut stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(NOT_STARTED.into());
    };
    let request = request.to_vec();
    // A worker that does not read its input must not block us: the writer has its own thread.
    let writer = thread::spawn(move || {
        let _ = stdin.write_all(&request);
    });
    let reader = thread::spawn(move || read_limited(stdout, wire::MAX_RESPONSE_BYTES));
    let errors = thread::spawn(move || read_limited(stderr, MAX_STDERR_BYTES));
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(TOO_LONG.into());
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(STOPPED.into());
            }
        }
    };
    let _ = writer.join();
    let response = reader.join().ok().flatten();
    let _ = errors.join();
    if !status.success() {
        return Err(STOPPED.into());
    }
    response.ok_or_else(|| BAD_ANSWER.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use octet_geometry::{AtomInput, BondInput, ForceField};

    fn ethanol(operation: Operation) -> Request {
        let atom = |atomic_number| AtomInput {
            atomic_number,
            isotope: 0,
            charge: 0,
            explicit_h: 0,
            no_implicit: false,
            aromatic: false,
            radical: 0,
            chiral_tag: 0,
        };
        let bond = |a, b| BondInput { a, b, order: 1, aromatic: false, stereo: 0, stereo_atoms: None };
        Request {
            atoms: vec![atom(6), atom(6), atom(8)],
            bonds: vec![bond(0, 1), bond(1, 2)],
            field: ForceField::MMFF94s,
            operation,
            coordinates: Vec::new(),
            fixed_atoms: Vec::new(),
            conformers: 2,
            seed: 0x52534b,
            max_iterations: 500,
        }
    }

    /// This test binary, run as a stand-in worker: the helper below hangs, crashes or answers with libtest's own
    /// output, which is not a frame.
    fn helper(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "geometry::client::tests::stand_in_worker", "--ignored", "--test-threads=1"])
            .env("OCTET_GEOMETRY_STAND_IN", mode);
        command
    }

    #[test]
    #[ignore = "a stand-in worker, run only by the tests below"]
    fn stand_in_worker() {
        match std::env::var("OCTET_GEOMETRY_STAND_IN").as_deref() {
            Ok("hang") => thread::sleep(Duration::from_secs(120)),
            Ok("crash") => std::process::exit(3),
            _ => {}
        }
    }

    #[test]
    fn a_hung_worker_is_killed_at_the_deadline() {
        let start = Instant::now();
        let error = execute_with(helper("hang"), ethanol(Operation::Generate), Duration::from_secs(2)).unwrap_err();
        assert_eq!(error, TOO_LONG);
        assert!(start.elapsed() < Duration::from_secs(30), "{:?}", start.elapsed());
    }

    #[test]
    fn a_crashing_or_wrong_worker_is_reported() {
        let error = execute_with(helper("crash"), ethanol(Operation::Generate), Duration::from_secs(60)).unwrap_err();
        assert_eq!(error, STOPPED);
        let error = execute_with(helper("answer"), ethanol(Operation::Generate), Duration::from_secs(60)).unwrap_err();
        assert_eq!(error, BAD_ANSWER);
    }

    fn answer(request: Request) -> (Vec<u8>, Expected) {
        let expected = Expected::of(&request).unwrap();
        let capacity = Capacity::for_heap(HEAP_BYTES);
        let result = super::super::worker::solve(wire::Request { heap_bytes: HEAP_BYTES, capacity: Some(capacity), operation: request });
        let bytes = wire::encode(&wire::Response { version: octet_geometry::VERSION.into(), result }, wire::MAX_RESPONSE_BYTES)
            .unwrap();
        (bytes, expected)
    }

    #[test]
    fn answers_are_checked_like_reshiki_does() {
        let capacity = Capacity::for_heap(HEAP_BYTES);
        let (bytes, expected) = answer(ethanol(Operation::Generate));
        let generated = check(&bytes, &expected, capacity).unwrap();
        assert_eq!(generated.coordinates.len(), 9);
        assert_eq!(generated.hydrogen_parents, [0, 0, 0, 1, 1, 2]);

        // Evaluate must return a gradient; a changed version, field or pinned atom is refused.
        let mut evaluate = ethanol(Operation::Evaluate);
        evaluate.coordinates = generated.coordinates.clone();
        let (bytes, expected) = answer(evaluate);
        let evaluated = check(&bytes, &expected, capacity).unwrap();
        assert_eq!(evaluated.gradient.as_ref().unwrap().len(), 9);
        let tamper = |edit: &dyn Fn(&mut wire::Response)| {
            let mut response: wire::Response = wire::decode(&bytes, wire::MAX_RESPONSE_BYTES).unwrap();
            edit(&mut response);
            let bytes = wire::encode(&response, wire::MAX_RESPONSE_BYTES).unwrap();
            check(&bytes, &expected, capacity)
        };
        assert!(tamper(&|_| {}).is_ok());
        assert_eq!(tamper(&|r| r.version = "other".into()).unwrap_err(), BAD_ANSWER);
        assert_eq!(tamper(&|r| r.result.as_mut().unwrap().gradient = None).unwrap_err(), BAD_ANSWER);
        assert_eq!(tamper(&|r| r.result.as_mut().unwrap().field = ForceField::UFF).unwrap_err(), BAD_ANSWER);
        assert_eq!(tamper(&|r| r.result.as_mut().unwrap().energy = f64::NAN).unwrap_err(), BAD_ANSWER);
        assert_eq!(tamper(&|r| r.result.as_mut().unwrap().hydrogen_parents[0] = 5).unwrap_err(), BAD_ANSWER);
        assert_eq!(tamper(&|r| r.result.as_mut().unwrap().coordinates.pop().map(|_| ()).unwrap()).unwrap_err(), BAD_ANSWER);

        let mut relax = ethanol(Operation::Relax);
        relax.coordinates = generated.coordinates;
        relax.fixed_atoms = vec![0, 4];
        relax.coordinates[1][0] += 0.05;
        let (bytes, expected) = answer(relax.clone());
        let relaxed = check(&bytes, &expected, capacity).unwrap();
        assert_eq!(relaxed.coordinates[0], relax.coordinates[0]);
        let mut response: wire::Response = wire::decode(&bytes, wire::MAX_RESPONSE_BYTES).unwrap();
        response.result.as_mut().unwrap().coordinates[4][1] += 1e-6;
        let moved = wire::encode(&response, wire::MAX_RESPONSE_BYTES).unwrap();
        assert_eq!(check(&moved, &expected, capacity).unwrap_err(), BAD_ANSWER);

        // A solver error reaches the page as it is.
        let mut borane = ethanol(Operation::Generate);
        borane.atoms.truncate(1);
        borane.atoms[0].atomic_number = 5;
        borane.bonds.clear();
        let (bytes, expected) = answer(borane);
        assert!(check(&bytes, &expected, capacity).unwrap_err().contains("MMFF parameters are unavailable"));
    }
}
