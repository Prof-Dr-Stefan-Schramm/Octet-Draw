// Picture to structure (decision 0023): the three recognition model files (two for structures, one for the text of
// reaction conditions), kept in Octet's data folder. They are not in the installer: the user downloads them once
// (about 280 MB together) or installs them from files, and from then on
// picture recognition runs offline. Octet takes only the exact files it knows: each one's size and SHA-256 are fixed
// here, and checked again each time a model is read. A model file is data for ONNX Runtime, never code.
use std::{fs, io::Write, path::PathBuf, time::Duration};

use sha2::{Digest, Sha256};
use tauri::{ipc::Response, AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

pub struct Model {
    pub name: &'static str,
    pub size: u64,
    pub sha256: &'static str,
    pub url: &'static str,
}

// Made by tools/recognise (export.py, quantize.py, pack.ts) from the published weights; the bench's numbers are for
// exactly these files.
pub const MODELS: [Model; 3] = [
    Model { name: "molscribe", size: 130_663_936, sha256: "74f2e40e8eeac053da2757a5d453cf5d54c34cbe16e8092db10119838d786d56", url: "https://github.com/SamChemMan/Octet-Draw/releases/download/models-1/molscribe.octmodel" },
    Model { name: "text", size: 7_833_476, sha256: "66fb40a81413682ef57ec47556fe75d08d5e18d95ec07c9443cc5550b256831c", url: "https://github.com/SamChemMan/Octet-Draw/releases/download/models-1/text.octmodel" },
    Model { name: "glyph", size: 137_249_503, sha256: "35b2c4dc077cbd1a578fe3b9465f3f135232e514b184af9b38f915aae1cb7b0e", url: "https://github.com/SamChemMan/Octet-Draw/releases/download/models-1/glyph.octmodel" },
];
const UNREACHED: &str = "Octet cannot download the picture recognition models.";

fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|d| d.join("models")).map_err(|e| e.to_string())
}

fn model(name: &str) -> Result<&'static Model, String> {
    MODELS.iter().find(|m| m.name == name).ok_or_else(|| "Octet has no model of that name.".to_string())
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

// The model a file is, by its size and SHA-256 (never its name).
fn which(bytes: &[u8]) -> Option<&'static Model> {
    let n = bytes.len() as u64;
    MODELS.iter().filter(|m| m.size == n).find(|m| m.sha256 == sha256(bytes))
}

// Written beside its place and then moved there, so a model file is never half written.
fn keep(app: &AppHandle, m: &Model, bytes: &[u8]) -> Result<(), String> {
    let dir = folder(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let part = dir.join(format!("{}.part", m.name));
    fs::write(&part, bytes).map_err(|e| e.to_string())?;
    fs::rename(&part, dir.join(format!("{}.octmodel", m.name))).map_err(|e| e.to_string())
}

// The models that are installed (by their size; read_model checks the rest).
#[tauri::command]
pub fn recognise_models(app: AppHandle) -> Vec<String> {
    let Ok(dir) = folder(&app) else { return vec![] };
    MODELS.iter().filter(|m| fs::metadata(dir.join(format!("{}.octmodel", m.name))).map(|f| f.len() == m.size).unwrap_or(false)).map(|m| m.name.to_string()).collect()
}

// A model's bytes for the page's recognition worker, after its SHA-256 is checked again.
#[tauri::command]
pub async fn recognise_model(app: AppHandle, name: String) -> Result<Response, String> {
    let m = model(&name)?;
    let bytes = fs::read(folder(&app)?.join(format!("{}.octmodel", m.name))).map_err(|_| "The model is not installed.".to_string())?;
    if bytes.len() as u64 != m.size || sha256(&bytes) != m.sha256 {
        return Err("The model file is damaged. Install it again.".into());
    }
    Ok(Response::new(bytes))
}

// Install from files the user picks (a computer without internet, or models copied from a colleague). Returns the
// models installed; a file that is not one of Octet's models is refused.
#[tauri::command]
pub async fn recognise_install(app: AppHandle) -> Result<Vec<String>, String> {
    let Some(files) = app.dialog().file().add_filter("Octet models", &["octmodel"]).blocking_pick_files() else { return Ok(vec![]) };
    let mut done = vec![];
    for f in files {
        let path = f.into_path().map_err(|e| e.to_string())?;
        let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
        if !MODELS.iter().any(|m| m.size == size) {
            return Err("This file is not one of Octet's picture recognition models.".into());
        }
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        let m = which(&bytes).ok_or("This file is not one of Octet's picture recognition models.")?;
        keep(&app, m, &bytes)?;
        done.push(m.name.to_string());
    }
    Ok(done)
}

// Download the models that are not installed, from Octet's fixed addresses only, after the user asks. The page hears
// "recognise-progress" with the bytes so far and in all.
#[tauri::command]
pub async fn recognise_download(app: AppHandle) -> Result<(), String> {
    let have = recognise_models(app.clone());
    let want: Vec<&Model> = MODELS.iter().filter(|m| !have.iter().any(|h| h == m.name)).collect();
    let total: u64 = want.iter().map(|m| m.size).sum();
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .user_agent(format!("Octet Draw {}", app.package_info().version))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| UNREACHED.to_string())?;
    let mut got = 0u64;
    for m in want {
        let mut response = client.get(m.url).send().await.map_err(|_| UNREACHED.to_string())?;
        if !response.status().is_success() {
            return Err(UNREACHED.into());
        }
        let mut bytes = Vec::with_capacity(m.size as usize);
        while let Some(chunk) = response.chunk().await.map_err(|_| UNREACHED.to_string())? {
            bytes.write_all(&chunk).map_err(|e| e.to_string())?;
            if bytes.len() as u64 > m.size {
                return Err(UNREACHED.into());
            }
            got += chunk.len() as u64;
            let _ = app.emit("recognise-progress", (got, total));
        }
        if which(&bytes).map(|k| k.name) != Some(m.name) {
            return Err("The downloaded model is damaged. Try again.".into());
        }
        keep(&app, m, &bytes)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_files_are_models() {
        assert!(which(b"OCTETMODEL1\n").is_none());
        assert_eq!(sha256(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert!(MODELS.iter().all(|m| m.sha256.len() == 64 && m.url.starts_with("https://")));
    }
}
