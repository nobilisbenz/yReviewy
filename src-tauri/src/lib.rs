use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Credentials {
    owner: String,
    repo: String,
    branch: String,
    token: String,
    device_id: String,
}

#[derive(Debug, Deserialize)]
struct CredentialsInput {
    owner: String,
    repo: String,
    branch: String,
    token: String,
}

#[derive(Debug, Serialize)]
struct PublicSettings {
    owner: String,
    repo: String,
    branch: String,
    device_id: String,
    token_present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ReviewEvent {
    event_id: String,
    device_id: String,
    card_uid: String,
    reviewed_at: i64,
    rating: u32,
    answer_correct: Option<bool>,
    response_ms: i64,
}

#[derive(Debug, Serialize)]
struct SyncResult {
    snapshot: Value,
    acknowledged_event_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubContent {
    content: String,
    sha: String,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("github.json"))
        .map_err(|error| error.to_string())
}

fn load_credentials(app: &AppHandle) -> Result<Credentials, String> {
    let path = settings_path(app)?;
    let source =
        fs::read_to_string(path).map_err(|_| "Pair this phone with GitHub first".to_string())?;
    serde_json::from_str(&source).map_err(|error| error.to_string())
}

fn public(credentials: Credentials) -> PublicSettings {
    PublicSettings {
        owner: credentials.owner,
        repo: credentials.repo,
        branch: credentials.branch,
        device_id: credentials.device_id,
        token_present: !credentials.token.is_empty(),
    }
}

fn validate_part(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
    {
        return Err(format!("Invalid GitHub {label}"));
    }
    Ok(())
}

#[tauri::command]
fn public_settings(app: AppHandle) -> Option<PublicSettings> {
    load_credentials(&app).ok().map(public)
}

#[tauri::command]
fn save_settings(app: AppHandle, input: CredentialsInput) -> Result<PublicSettings, String> {
    let owner = input.owner.trim().to_string();
    let repo = input.repo.trim().trim_end_matches(".git").to_string();
    let branch = input.branch.trim().to_string();
    validate_part("owner", &owner)?;
    validate_part("repository", &repo)?;
    validate_part("branch", &branch)?;
    if input.token.trim().is_empty() {
        return Err("GitHub token cannot be empty".into());
    }
    let device_id = load_credentials(&app)
        .ok()
        .map(|value| value.device_id)
        .unwrap_or_else(|| {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            format!("android-{timestamp}-{}", std::process::id())
        });
    let credentials = Credentials {
        owner,
        repo,
        branch,
        token: input.token.trim().to_string(),
        device_id,
    };
    let path = settings_path(&app)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|error| error.to_string())?;
    fs::write(
        &path,
        serde_json::to_vec(&credentials).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(public(credentials))
}

#[tauri::command]
fn clear_settings(app: AppHandle) -> Result<(), String> {
    let path = settings_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn api_url(credentials: &Credentials, path: &str) -> String {
    format!(
        "https://api.github.com/repos/{}/{}/contents/{}",
        credentials.owner, credentials.repo, path
    )
}

async fn get_content(
    client: &Client,
    credentials: &Credentials,
    path: &str,
) -> Result<Option<GitHubContent>, String> {
    let response = client
        .get(api_url(credentials, path))
        .query(&[("ref", &credentials.branch)])
        .bearer_auth(&credentials.token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("GitHub {status}: {body}"));
    }
    response
        .json()
        .await
        .map(Some)
        .map_err(|error| error.to_string())
}

fn decode_content(content: &GitHubContent) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(content.content.replace(['\n', '\r'], ""))
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn sync_github(app: AppHandle, pending: Vec<ReviewEvent>) -> Result<SyncResult, String> {
    let credentials = load_credentials(&app)?;
    let client = Client::builder()
        .user_agent("yReviewy/0.1")
        .build()
        .map_err(|error| error.to_string())?;
    let log_path = format!(".notes/mobile-reviews/{}.jsonl", credentials.device_id);
    let existing = get_content(&client, &credentials, &log_path).await?;
    let mut events: Vec<ReviewEvent> = match existing.as_ref() {
        Some(content) => String::from_utf8(decode_content(content)?)
            .map_err(|error| error.to_string())?
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect(),
        None => Vec::new(),
    };
    let known: std::collections::HashSet<_> =
        events.iter().map(|event| event.event_id.clone()).collect();
    events.extend(
        pending
            .iter()
            .filter(|event| !known.contains(&event.event_id))
            .cloned(),
    );
    if !pending.is_empty() {
        let mut source = events
            .iter()
            .map(serde_json::to_string)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
            .join("\n");
        if !source.is_empty() {
            source.push('\n');
        }
        let mut body = serde_json::json!({
            "message": format!("Sync reviews from {}", credentials.device_id),
            "content": base64::engine::general_purpose::STANDARD.encode(source),
            "branch": credentials.branch,
        });
        if let Some(existing) = &existing {
            body["sha"] = Value::String(existing.sha.clone());
        }
        let response = client
            .put(api_url(&credentials, &log_path))
            .bearer_auth(&credentials.token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .json(&body)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            let status = response.status();
            return Err(format!(
                "GitHub {status}: {}",
                response.text().await.unwrap_or_default()
            ));
        }
    }
    let snapshot = get_content(&client, &credentials, ".notes/mobile-snapshot.json")
        .await?
        .ok_or_else(|| "No mobile snapshot yet. Run yalive sync on your PC first.".to_string())?;
    let snapshot =
        serde_json::from_slice(&decode_content(&snapshot)?).map_err(|error| error.to_string())?;
    Ok(SyncResult {
        snapshot,
        acknowledged_event_ids: pending.into_iter().map(|event| event.event_id).collect(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            public_settings,
            save_settings,
            clear_settings,
            sync_github
        ])
        .run(tauri::generate_context!())
        .expect("error while running yReviewy");
}
