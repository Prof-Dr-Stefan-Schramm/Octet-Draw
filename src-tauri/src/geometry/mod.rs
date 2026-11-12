// 3D Optimise: force-field geometry (distance geometry, then MMFF94, MMFF94s or UFF) in a worker process. The worker is
// this executable started with --geometry-worker (main.rs checks that first). A crash, a hang or a large molecule in
// the worker cannot harm the open drawing; the worker is stopped after 60 seconds.
mod client;
mod wire;
mod worker;

pub use worker::run as worker_main;

// One request from the page: generate a 3D structure, relax one or evaluate its energy. The result keeps the request's
// atoms first, in order, then the added hydrogens with their parents. Errors are short text for the user.
#[tauri::command]
pub async fn geometry_generate(request: octet_geometry::Request) -> Result<octet_geometry::Response, String> {
    tauri::async_runtime::spawn_blocking(move || client::execute(request))
        .await
        .map_err(|_| client::STOPPED.to_string())?
}
