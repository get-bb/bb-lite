use std::path::Path;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bb_server::providers::title_service::{
    TitleEndpoints, TitleError, TitleHttpClient, TitleHttpRequest, TitleHttpResponse, clean_title,
    codex_title,
};
use parking_lot::Mutex;
use serde_json::{Value, json};

fn part(delta: &str) -> String {
    format!("data: {}\n\n", json!({"type": "response.output_text.delta", "delta": delta}))
}

type Seen = (String, String, Option<String>, Option<String>);

#[derive(Default)]
struct FakeEndpoint {
    seen: Mutex<Vec<Seen>>,
    offline: bool,
}

#[async_trait]
impl TitleHttpClient for FakeEndpoint {
    async fn post(&self, request: TitleHttpRequest) -> Result<TitleHttpResponse, TitleError> {
        if self.offline {
            return Err(TitleError::Request("fetch failed".into()));
        }
        let body: Value = serde_json::from_str(&request.body).unwrap();
        let header = |name: &str| {
            request
                .headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.clone())
        };
        let mut seen = self.seen.lock();
        let model = body["model"].as_str().unwrap().to_string();
        seen.push((
            request.url.clone(),
            model,
            header("authorization"),
            header("chatgpt-account-id"),
        ));
        let status = if seen.len() == 1 { 429 } else { 200 };
        let stream = format!("{}{}data: [DONE]", part("Title: \"Fix the flaky"), part(" test\""));
        Ok(TitleHttpResponse { status, body: stream })
    }
}

fn login(home: &Path, auth: Value) {
    std::fs::write(home.join("auth.json"), auth.to_string()).unwrap();
}

#[tokio::test]
async fn titles_come_from_the_codex_login_and_survive_a_rate_limit() {
    let scratch = tempfile::tempdir().unwrap();
    let home = scratch.path().to_str().unwrap();
    let urls =
        TitleEndpoints { chatgpt: "http://fake/chatgpt".into(), api_key: "http://fake/key".into() };
    let endpoint = FakeEndpoint::default();
    let title = || codex_title("fix it", &endpoint, &urls, Some(home));
    assert_eq!(title().await.unwrap(), None);
    let expired = URL_SAFE_NO_PAD.encode(br#"{"exp":1}"#);
    login(
        scratch.path(),
        json!({"tokens": {"access_token": format!("a.{expired}.c"), "account_id": "acct"}}),
    );
    assert_eq!(title().await.unwrap(), None);
    login(scratch.path(), json!({"tokens": {"access_token": "a.e30.c", "account_id": "acct"}}));
    let offline = FakeEndpoint { offline: true, ..Default::default() };
    assert!(codex_title("fix it", &offline, &urls, Some(home)).await.is_err());
    assert_eq!(title().await.unwrap().as_deref(), Some("Fix the flaky test"));
    login(scratch.path(), json!({"OPENAI_API_KEY": "sk-test", "tokens": null}));
    assert_eq!(title().await.unwrap().as_deref(), Some("Fix the flaky test"));
    let seen = endpoint.seen.lock().clone();
    let entry = |url: &str, model: &str, auth: &str, account: Option<&str>| {
        (url.to_string(), model.to_string(), Some(auth.to_string()), account.map(str::to_string))
    };
    assert_eq!(
        seen,
        [
            entry("http://fake/chatgpt", "gpt-6-luna", "Bearer a.e30.c", Some("acct")),
            entry("http://fake/chatgpt", "gpt-5.6-luna", "Bearer a.e30.c", Some("acct")),
            entry("http://fake/key", "gpt-6-luna", "Bearer sk-test", None),
        ]
    );
    assert_eq!(
        TitleEndpoints::default().chatgpt,
        "https://chatgpt.com/backend-api/codex/responses"
    );
}

#[tokio::test]
async fn http_errors_other_than_rate_limits_fail() {
    struct Refusing;
    #[async_trait]
    impl TitleHttpClient for Refusing {
        async fn post(&self, _: TitleHttpRequest) -> Result<TitleHttpResponse, TitleError> {
            Ok(TitleHttpResponse { status: 401, body: String::new() })
        }
    }
    let scratch = tempfile::tempdir().unwrap();
    login(scratch.path(), json!({"OPENAI_API_KEY": "sk-test"}));
    let urls = TitleEndpoints::default();
    let error = codex_title("x", &Refusing, &urls, scratch.path().to_str()).await.unwrap_err();
    assert_eq!(error.to_string(), "Codex title: HTTP 401");
}

#[test]
fn cleans_model_replies_into_titles() {
    let wordy = format!("<think>hm</think>\n- **`{}`**", "word ".repeat(12));
    assert_eq!(clean_title(&wordy).as_deref(), Some("word ".repeat(9).trim()));
    assert_eq!(clean_title("Here is the title:\n\n"), None);
    assert_eq!(clean_title("<thinking>open\nstill thinking").as_deref(), None);
    assert_eq!(
        clean_title("Thread title: \u{201C}Fix  login\u{201D}").as_deref(),
        Some("Fix login")
    );
}
